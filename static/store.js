// On-device storage for Iron Log. Data lives in IndexedDB on each phone/browser,
// with a localStorage fallback and an in-memory last resort.
const IronStore = (() => {
  const DB_NAME = 'iron-log';
  const DB_VERSION = 1;
  const OBJECT_STORE = 'state';
  const STATE_KEY = 'main';
  const FALLBACK_KEY = 'iron-log-state';
  const SCHEMA_VERSION = 1;
  const BACKUP_FORMAT = 'iron-log-backup';

  const STARTER_ROUTINES = [
    {
      name: 'Push',
      exercises: ['Incline Dumbbell Press', 'Machine Chest Press', 'Cable Triceps Extension', 'Lateral Raise'],
    },
    {
      name: 'Pull 1',
      exercises: ['Lat Pulldown', 'Machine Row', 'Barbell Curl', 'Face Pull'],
    },
    {
      name: 'Legs',
      exercises: ['Back Squat', 'Romanian Deadlift', 'Leg Press', 'Standing Calf Raise'],
    },
  ];

  const DEFAULT_SETTINGS = { vibrate: true, sound: true };

  let backend = 'memory';
  let dbPromise = null;
  let state = null;
  let memoryCopy = null;

  class ValidationError extends Error {}

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function cleanText(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  }

  function clampNumber(value, min, max, fallback, integer = false) {
    let number = Number(value);
    if (!Number.isFinite(number)) {
      number = fallback;
    }
    if (integer) {
      number = Math.round(number);
    }
    return Math.min(max, Math.max(min, number));
  }

  function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function normalizeExercise(raw) {
    const source = typeof raw === 'string' ? { name: raw } : raw || {};
    const name = cleanText(source.name, 120);
    if (!name) {
      throw new ValidationError('Every exercise needs a name.');
    }
    return {
      name,
      restSeconds: clampNumber(source.restSeconds, 0, 3600, 90, true),
      defaultWeightKg: clampNumber(source.defaultWeightKg, 0, 1000, 0),
      defaultReps: clampNumber(source.defaultReps, 1, 1000, 10, true),
      defaultSets: clampNumber(source.defaultSets, 1, 20, 3, true),
      warmupSets: clampNumber(source.warmupSets, 0, 10, 0, true),
      warmupRestSeconds: clampNumber(source.warmupRestSeconds, 0, 3600, 45, true),
      notes: cleanText(source.notes, 500),
    };
  }

  function normalizeRoutine(raw, id) {
    const name = cleanText(raw && raw.name, 60);
    if (!name) {
      throw new ValidationError('Routine name is required.');
    }
    const sourceExercises = Array.isArray(raw.exerciseDetails) && raw.exerciseDetails.length
      ? raw.exerciseDetails
      : raw.exercises;
    if (!Array.isArray(sourceExercises) || !sourceExercises.length) {
      throw new ValidationError(`Routine "${name}" needs at least one exercise.`);
    }
    return { id, name, exercises: sourceExercises.map(normalizeExercise) };
  }

  function normalizeWorkout(raw, id) {
    const name = cleanText(raw && raw.name, 120);
    if (!name) {
      throw new ValidationError('Every workout entry needs an exercise name.');
    }
    if (!Array.isArray(raw.sets) || !raw.sets.length) {
      throw new ValidationError(`Workout entry "${name}" has no sets.`);
    }
    const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)
      ? raw.date
      : localDateString();
    return {
      id,
      date,
      completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
      name,
      muscleGroup: cleanText(raw.muscleGroup, 120) || 'Workout',
      sets: raw.sets.map((set) => ({
        weightKg: clampNumber(set && set.weightKg, 0, 1000, 0),
        reps: clampNumber(set && set.reps, 1, 1000, 1, true),
        isWarmup: Boolean(set && set.isWarmup),
      })),
      notes: cleanText(raw.notes, 500),
    };
  }

  function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      vibrate: typeof source.vibrate === 'boolean' ? source.vibrate : DEFAULT_SETTINGS.vibrate,
      sound: typeof source.sound === 'boolean' ? source.sound : DEFAULT_SETTINGS.sound,
    };
  }

  function buildState(routines, workouts, settings) {
    if (!Array.isArray(routines) || !Array.isArray(workouts)) {
      throw new ValidationError('Backup must contain "routines" and "workouts" lists.');
    }
    const normalizedRoutines = routines.map((routine, index) => normalizeRoutine(routine, index + 1));
    // Imported workouts are newest first; keep ascending IDs so newer entries get higher IDs.
    const normalizedWorkouts = [...workouts]
      .reverse()
      .map((workout, index) => normalizeWorkout(workout, index + 1))
      .reverse();
    return {
      schemaVersion: SCHEMA_VERSION,
      nextRoutineId: normalizedRoutines.length + 1,
      nextWorkoutId: normalizedWorkouts.length + 1,
      routines: normalizedRoutines,
      workouts: normalizedWorkouts,
      settings: normalizeSettings(settings),
    };
  }

  function createStarterState() {
    return buildState(STARTER_ROUTINES, [], DEFAULT_SETTINGS);
  }

  function isValidState(candidate) {
    return Boolean(
      candidate
      && candidate.schemaVersion === SCHEMA_VERSION
      && Array.isArray(candidate.routines)
      && Array.isArray(candidate.workouts)
      && Number.isInteger(candidate.nextRoutineId)
      && Number.isInteger(candidate.nextWorkoutId),
    );
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(OBJECT_STORE)) {
          request.result.createObjectStore(OBJECT_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Storage is blocked by another open Iron Log tab.'));
    });
  }

  function runTransaction(mode, operation) {
    return dbPromise.then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(OBJECT_STORE, mode);
      const request = operation(transaction.objectStore(OBJECT_STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Storage transaction aborted.'));
    }));
  }

  async function readRaw() {
    if (backend === 'indexeddb') {
      return runTransaction('readonly', (store) => store.get(STATE_KEY));
    }
    if (backend === 'localstorage') {
      const text = localStorage.getItem(FALLBACK_KEY);
      return text ? JSON.parse(text) : undefined;
    }
    return memoryCopy ? clone(memoryCopy) : undefined;
  }

  async function writeRaw(nextState) {
    if (backend === 'indexeddb') {
      await runTransaction('readwrite', (store) => store.put(nextState, STATE_KEY));
      return;
    }
    if (backend === 'localstorage') {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(nextState));
      return;
    }
    memoryCopy = clone(nextState);
  }

  async function chooseBackend() {
    if (typeof indexedDB !== 'undefined') {
      try {
        dbPromise = openDatabase();
        await dbPromise;
        backend = 'indexeddb';
        return;
      } catch (error) {
        console.warn('IndexedDB unavailable, falling back to localStorage.', error);
        dbPromise = null;
      }
    }
    try {
      const probe = `${FALLBACK_KEY}-probe`;
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      backend = 'localstorage';
    } catch (error) {
      console.warn('localStorage unavailable, data will not persist.', error);
      backend = 'memory';
    }
  }

  async function init() {
    await chooseBackend();
    const stored = await readRaw();
    if (isValidState(stored)) {
      state = stored;
      state.settings = normalizeSettings(state.settings);
    } else {
      state = createStarterState();
      await writeRaw(state);
    }
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    return { backend };
  }

  function ensureReady() {
    if (!state) {
      throw new Error('Storage is not ready yet.');
    }
  }

  // Applies a mutation to a copy and only swaps it in after a successful write.
  async function commit(mutator) {
    ensureReady();
    const draft = clone(state);
    const result = mutator(draft);
    await writeRaw(draft);
    state = draft;
    return result;
  }

  function toRoutineView(routine) {
    return {
      id: routine.id,
      name: routine.name,
      exercises: routine.exercises.map((exercise) => exercise.name),
      exerciseDetails: routine.exercises.map((exercise) => ({ id: null, ...exercise })),
    };
  }

  function getRoutines() {
    ensureReady();
    return state.routines.map(toRoutineView);
  }

  function getWorkouts() {
    ensureReady();
    return clone(state.workouts);
  }

  function getSettings() {
    ensureReady();
    return { ...state.settings };
  }

  function getBackend() {
    return backend;
  }

  function createRoutine(name, exerciseNames) {
    return commit((draft) => {
      const routine = normalizeRoutine({ name, exercises: exerciseNames }, draft.nextRoutineId);
      draft.nextRoutineId += 1;
      draft.routines.push(routine);
      return toRoutineView(routine);
    });
  }

  function updateRoutine(id, name, exercises) {
    return commit((draft) => {
      const index = draft.routines.findIndex((routine) => routine.id === id);
      if (index === -1) {
        throw new ValidationError('Routine not found.');
      }
      const routine = normalizeRoutine({ name, exerciseDetails: exercises }, id);
      draft.routines[index] = routine;
      return toRoutineView(routine);
    });
  }

  function addWorkoutEntries(entries) {
    return commit((draft) => {
      const completedAt = new Date().toISOString();
      const saved = entries.map((entry) => {
        const workout = normalizeWorkout({ completedAt, ...entry }, draft.nextWorkoutId);
        draft.nextWorkoutId += 1;
        return workout;
      });
      draft.workouts.unshift(...saved.reverse());
      return saved.length;
    });
  }

  function updateSettings(changes) {
    return commit((draft) => {
      draft.settings = normalizeSettings({ ...draft.settings, ...changes });
      return { ...draft.settings };
    });
  }

  function createBackup() {
    ensureReady();
    return {
      format: BACKUP_FORMAT,
      app: 'Iron Log',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      routines: getRoutines().map(({ name, exerciseDetails }) => ({
        name,
        exercises: exerciseDetails.map(({ id, ...exercise }) => exercise),
      })),
      workouts: state.workouts.map(({ id, ...workout }) => workout),
      settings: { ...state.settings },
    };
  }

  // Accepts this app's JSON backup or the server's {routines, workouts} payload.
  async function replaceAll(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new ValidationError('The backup file is empty or not valid JSON.');
    }
    if (payload.format && payload.format !== BACKUP_FORMAT) {
      throw new ValidationError('This file is not an Iron Log backup.');
    }
    if (payload.schemaVersion && payload.schemaVersion > SCHEMA_VERSION) {
      throw new ValidationError('This backup was made by a newer Iron Log version.');
    }
    if (!Array.isArray(payload.routines) || !Array.isArray(payload.workouts)) {
      throw new ValidationError('Backup must contain "routines" and "workouts" lists.');
    }
    const routines = payload.routines.map((routine) => ({
      name: routine && routine.name,
      exerciseDetails: routine && (routine.exerciseDetails || routine.exercises),
    }));
    const nextState = buildState(routines, payload.workouts, payload.settings || state.settings);
    await writeRaw(nextState);
    state = nextState;
    return { routines: nextState.routines.length, workouts: nextState.workouts.length };
  }

  return {
    ValidationError,
    init,
    getBackend,
    getRoutines,
    getWorkouts,
    getSettings,
    createRoutine,
    updateRoutine,
    addWorkoutEntries,
    updateSettings,
    createBackup,
    replaceAll,
    localDateString,
  };
})();

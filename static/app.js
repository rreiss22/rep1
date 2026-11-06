const routineList = document.getElementById('routine-list');
const routineCount = document.getElementById('routine-count');
const status = document.getElementById('status');
const searchWrap = document.getElementById('search-wrap');
const searchInput = document.getElementById('routine-search');
const dialog = document.getElementById('routine-dialog');
const routineForm = document.getElementById('routine-form');
const formError = document.getElementById('form-error');
const dataDialog = document.getElementById('data-dialog');
const backupMessage = document.getElementById('backup-message');
const homeView = document.getElementById('home-view');
const routineDetailsView = document.getElementById('routine-details-view');
const activeWorkoutView = document.getElementById('active-workout-view');
const activeExerciseList = document.getElementById('active-exercise-list');
const workoutMessage = document.getElementById('workout-message');

let routines = [];
let selectedRoutine = null;
let activeWorkout = null;
let timerId = null;
let restTimerId = null;
let restEndsAt = 0;

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || 'The request could not be completed.');
  }
  return payload;
}

function createInitialSets(weightKg = 0, reps = 10, setCount = 3, warmupCount = 0) {
  const warmups = Array.from({ length: warmupCount }, () => ({
    weightKg: Math.round(weightKg * 0.5 * 2) / 2,
    reps,
    completed: false,
    isWarmup: true,
  }));
  const working = Array.from({ length: setCount }, () => ({
    weightKg,
    reps,
    completed: false,
    isWarmup: false,
  }));
  return [...warmups, ...working];
}

function setLabel(sets, index) {
  if (sets[index].isWarmup) {
    const warmupNumber = sets.slice(0, index + 1).filter((set) => set.isWarmup).length;
    return { text: `W${warmupNumber}`, description: `warm-up set ${warmupNumber}` };
  }
  const workingNumber = sets.slice(0, index + 1).filter((set) => !set.isWarmup).length;
  return { text: String(workingNumber), description: `set ${workingNumber}` };
}

let audioContext = null;

// Audio must be unlocked from a user tap (e.g. completing a set) before the timer can beep.
function primeAudio(force = false) {
  if (!force && !IronStore.getSettings().sound) {
    return;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }
  try {
    audioContext = audioContext || new AudioContextClass();
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  } catch (error) {
    console.warn('Audio unavailable', error);
    audioContext = null;
  }
}

function playRestBeep() {
  if (!audioContext || audioContext.state !== 'running') {
    return;
  }
  const start = audioContext.currentTime + 0.02;
  [0, 0.28, 0.56].forEach((offset, index) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = index === 2 ? 1175 : 880;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.35, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.2);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.22);
  });
}

function notifyRestComplete() {
  let settings;
  try {
    settings = IronStore.getSettings();
  } catch (error) {
    return;
  }
  if (settings.vibrate && 'vibrate' in navigator) {
    try {
      navigator.vibrate([300, 150, 300, 150, 500]);
    } catch (error) {
      console.warn('Vibration unavailable', error);
    }
  }
  if (settings.sound) {
    playRestBeep();
  }
}

function stopRestTimer() {
  clearInterval(restTimerId);
  restTimerId = null;
  restEndsAt = 0;
  document.getElementById('rest-timer').hidden = true;
}

function updateRestTimer() {
  const timer = document.getElementById('rest-timer');
  const countdown = document.getElementById('rest-timer-countdown');
  const remaining = Math.max(0, Math.ceil((restEndsAt - Date.now()) / 1000));
  if (remaining <= 0) {
    clearInterval(restTimerId);
    restTimerId = null;
    timer.classList.add('complete');
    countdown.textContent = 'Rest complete';
    notifyRestComplete();
    return;
  }

  timer.classList.remove('complete');
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  countdown.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function startRestTimer(exercise, isWarmup = false) {
  const seconds = isWarmup ? exercise.warmupRestSeconds : exercise.restSeconds;
  if (!seconds) {
    stopRestTimer();
    return;
  }
  clearInterval(restTimerId);
  primeAudio();
  restEndsAt = Date.now() + seconds * 1000;
  document.getElementById('rest-timer-label').textContent =
    `${isWarmup ? 'Warm-up rest' : 'Rest'} after ${exercise.name}`;
  document.getElementById('rest-timer').hidden = false;
  updateRestTimer();
  restTimerId = window.setInterval(updateRestTimer, 250);
}

function updateWorkoutStats() {
  if (!activeWorkout) {
    return;
  }

  let volume = 0;
  let completedSets = 0;
  activeWorkout.exercises.forEach((exercise) => {
    exercise.sets.forEach((set) => {
      if (set.completed && !set.isWarmup) {
        completedSets += 1;
        volume += set.weightKg * set.reps;
      }
    });
  });

  document.getElementById('workout-volume').textContent = `${volume.toLocaleString()} kg`;
  document.getElementById('completed-sets').textContent = String(completedSets);
}

function updateDuration() {
  if (!activeWorkout) {
    return;
  }

  const elapsedSeconds = Math.floor((Date.now() - activeWorkout.startedAt) / 1000);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  document.getElementById('workout-duration').textContent =
    `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function syncSetFromRow(exerciseIndex, setIndex, row) {
  const set = activeWorkout.exercises[exerciseIndex].sets[setIndex];
  const weightInput = row.querySelector('[data-field="weight"]');
  const repsInput = row.querySelector('[data-field="reps"]');
  set.weightKg = Math.max(0, Number(weightInput.value) || 0);
  set.reps = Math.max(1, Number(repsInput.value) || 1);
}

function createSetRow(exerciseIndex, setIndex, onStructureChange) {
  const sets = activeWorkout.exercises[exerciseIndex].sets;
  const set = sets[setIndex];
  const label = setLabel(sets, setIndex);
  const row = document.createElement('div');
  row.className = `set-row${set.completed ? ' completed' : ''}${set.isWarmup ? ' warmup' : ''}`;

  const number = document.createElement('span');
  number.className = 'set-number';
  number.textContent = label.text;
  if (set.isWarmup) {
    number.title = 'Warm-up set (not counted in totals)';
  }

  const weightInput = document.createElement('input');
  weightInput.type = 'number';
  weightInput.min = '0';
  weightInput.step = '0.5';
  weightInput.value = String(set.weightKg);
  weightInput.dataset.field = 'weight';
  weightInput.setAttribute('aria-label', `${label.description} weight in kilograms`);

  const repsInput = document.createElement('input');
  repsInput.type = 'number';
  repsInput.min = '1';
  repsInput.step = '1';
  repsInput.value = String(set.reps);
  repsInput.dataset.field = 'reps';
  repsInput.setAttribute('aria-label', `${label.description} repetitions`);

  const completeButton = document.createElement('button');
  completeButton.type = 'button';
  completeButton.className = 'set-complete-button';
  completeButton.textContent = set.completed ? '✓' : '○';
  completeButton.setAttribute(
    'aria-label',
    `${set.completed ? 'Reopen' : 'Complete'} ${label.description}`,
  );
  completeButton.addEventListener('click', () => {
    syncSetFromRow(exerciseIndex, setIndex, row);
    set.completed = !set.completed;
    row.classList.toggle('completed', set.completed);
    completeButton.textContent = set.completed ? '✓' : '○';
    completeButton.setAttribute(
      'aria-label',
      `${set.completed ? 'Reopen' : 'Complete'} ${label.description}`,
    );
    if (set.completed) {
      startRestTimer(activeWorkout.exercises[exerciseIndex], set.isWarmup);
    }
    updateWorkoutStats();
  });

  weightInput.addEventListener('change', () => {
    syncSetFromRow(exerciseIndex, setIndex, row);
    updateWorkoutStats();
  });
  repsInput.addEventListener('change', () => {
    syncSetFromRow(exerciseIndex, setIndex, row);
    updateWorkoutStats();
  });

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'set-remove-button';
  removeButton.textContent = '×';
  removeButton.setAttribute('aria-label', `Remove ${label.description}`);
  removeButton.addEventListener('click', () => {
    sets.splice(setIndex, 1);
    onStructureChange();
    updateWorkoutStats();
  });

  row.append(number, weightInput, repsInput, completeButton, removeButton);
  return row;
}

function renderSetRows(exerciseIndex, rows) {
  const sets = activeWorkout.exercises[exerciseIndex].sets;
  rows.replaceChildren();
  sets.forEach((_, setIndex) => {
    rows.append(createSetRow(exerciseIndex, setIndex, () => renderSetRows(exerciseIndex, rows)));
  });
}

function createExerciseCard(exercise, exerciseIndex) {
  const card = document.createElement('section');
  card.className = 'active-exercise-card';

  const header = document.createElement('div');
  header.className = 'exercise-card-header';

  const marker = document.createElement('span');
  marker.className = 'exercise-marker';
  marker.textContent = String(exerciseIndex + 1).padStart(2, '0');

  const headingWrap = document.createElement('div');
  headingWrap.className = 'exercise-card-heading';
  const title = document.createElement('h2');
  title.textContent = exercise.name;
  const subtitle = document.createElement('small');
  subtitle.textContent = exercise.warmupSets
    ? `Rest target: ${exercise.restSeconds}s · Warm-up rest: ${exercise.warmupRestSeconds}s`
    : `Rest target: ${exercise.restSeconds} seconds`;
  headingWrap.append(title, subtitle);
  const startRestButton = document.createElement('button');
  startRestButton.type = 'button';
  startRestButton.className = 'start-rest-button';
  startRestButton.textContent = 'Start rest';
  startRestButton.addEventListener('click', () => startRestTimer(exercise));
  header.append(marker, headingWrap, startRestButton);

  const noteWrap = document.createElement('label');
  noteWrap.className = 'exercise-note';
  const noteLabel = document.createElement('span');
  noteLabel.className = 'sr-only';
  noteLabel.textContent = `Notes for ${exercise.name}`;
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.placeholder = 'Add a form cue or note';
  noteInput.value = exercise.notes;
  noteInput.addEventListener('input', () => {
    exercise.notes = noteInput.value;
  });
  noteWrap.append(noteLabel, noteInput);

  const tableHeader = document.createElement('div');
  tableHeader.className = 'set-table-header';
  ['Set', 'kg', 'Reps', 'Done', ''].forEach((label) => {
    const cell = document.createElement('span');
    cell.textContent = label;
    tableHeader.append(cell);
  });

  const rows = document.createElement('div');
  rows.className = 'set-rows';
  renderSetRows(exerciseIndex, rows);

  const addButtons = document.createElement('div');
  addButtons.className = 'add-set-row';

  const addWarmupButton = document.createElement('button');
  addWarmupButton.type = 'button';
  addWarmupButton.className = 'add-set-button warmup';
  addWarmupButton.textContent = '+ Warm-up set';
  addWarmupButton.addEventListener('click', () => {
    const lastWarmupIndex = exercise.sets.reduce(
      (last, set, index) => (set.isWarmup ? index : last),
      -1,
    );
    exercise.sets.splice(lastWarmupIndex + 1, 0, {
      weightKg: Math.round(exercise.defaultWeightKg * 0.5 * 2) / 2,
      reps: exercise.defaultReps,
      completed: false,
      isWarmup: true,
    });
    renderSetRows(exerciseIndex, rows);
    updateWorkoutStats();
  });

  const addSetButton = document.createElement('button');
  addSetButton.type = 'button';
  addSetButton.className = 'add-set-button';
  addSetButton.textContent = '+ Add set';
  addSetButton.addEventListener('click', () => {
    exercise.sets.push({
      weightKg: exercise.defaultWeightKg,
      reps: exercise.defaultReps,
      completed: false,
      isWarmup: false,
    });
    renderSetRows(exerciseIndex, rows);
    updateWorkoutStats();
  });

  addButtons.append(addWarmupButton, addSetButton);

  card.append(header, noteWrap, tableHeader, rows, addButtons);
  return card;
}

function renderActiveWorkout() {
  activeExerciseList.replaceChildren();
  if (!activeWorkout.exercises.length) {
    const empty = document.createElement('div');
    empty.className = 'no-exercises';
    empty.textContent = 'This empty workout has no exercises yet. Return to routines to choose a prepared plan.';
    activeExerciseList.append(empty);
    return;
  }

  activeWorkout.exercises.forEach((exercise, index) => {
    activeExerciseList.append(createExerciseCard(exercise, index));
  });
}

function startWorkout(routine) {
  stopRestTimer();
  const exerciseDetails = getExerciseDetails(routine);
  activeWorkout = {
    name: routine.name,
    startedAt: Date.now(),
    exercises: exerciseDetails.map((exercise) => ({
      name: exercise.name,
      restSeconds: exercise.restSeconds,
      warmupRestSeconds: exercise.warmupRestSeconds ?? 45,
      warmupSets: exercise.warmupSets ?? 0,
      defaultWeightKg: exercise.defaultWeightKg,
      defaultReps: exercise.defaultReps,
      notes: exercise.notes || '',
      sets: createInitialSets(
        exercise.defaultWeightKg,
        exercise.defaultReps,
        exercise.defaultSets,
        exercise.warmupSets ?? 0,
      ),
    })),
  };

  document.getElementById('workout-name').textContent = routine.name;
  workoutMessage.textContent = '';
  workoutMessage.classList.remove('error');
  homeView.hidden = true;
  routineDetailsView.hidden = true;
  activeWorkoutView.hidden = false;
  renderActiveWorkout();
  updateWorkoutStats();
  updateDuration();
  clearInterval(timerId);
  timerId = window.setInterval(updateDuration, 1000);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function returnToRoutines() {
  clearInterval(timerId);
  stopRestTimer();
  timerId = null;
  activeWorkout = null;
  activeWorkoutView.hidden = true;
  routineDetailsView.hidden = true;
  homeView.hidden = false;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderRoutineDetails() {
  if (!selectedRoutine) {
    return;
  }

  const routine = selectedRoutine;
  document.getElementById('detail-routine-name').textContent = routine.name;
  document.getElementById('detail-routine-summary').textContent =
    `${routine.exercises.length} exercise${routine.exercises.length === 1 ? '' : 's'} in this training plan.`;
  document.getElementById('detail-exercise-count').textContent = String(routine.exercises.length);

  const exerciseList = document.getElementById('detail-exercise-list');
  exerciseList.replaceChildren();
  const details = getExerciseDetails(routine);
  routine.exercises.forEach((exercise, index) => {
    const item = document.createElement('li');
    item.className = 'detail-exercise-item';
    const warmupSets = details[index] ? details[index].warmupSets || 0 : 0;
    item.textContent = warmupSets
      ? `${exercise} · ${warmupSets} warm-up set${warmupSets === 1 ? '' : 's'}`
      : exercise;
    exerciseList.append(item);
  });
}

function getExerciseDetails(routine) {
  return routine.exerciseDetails || routine.exercises.map((name) => ({
    name,
    restSeconds: 90,
    defaultWeightKg: 0,
    defaultReps: 10,
    defaultSets: 3,
    warmupSets: 0,
    warmupRestSeconds: 45,
    notes: '',
  }));
}

function moveEditableExercise(item, direction) {
  const sibling = direction < 0 ? item.previousElementSibling : item.nextElementSibling;
  if (!sibling) {
    return;
  }
  if (direction < 0) {
    item.parentElement.insertBefore(item, sibling);
  } else {
    item.parentElement.insertBefore(sibling, item);
  }
}

function removeEditableExercise(item) {
  const message = document.getElementById('routine-edit-message');
  if (document.querySelectorAll('.editable-exercise').length <= 1) {
    message.textContent = 'A routine must keep at least one exercise.';
    message.classList.add('error');
    return;
  }
  item.remove();
  message.textContent = '';
  message.classList.remove('error');
}

function createEditableExercise(exercise) {
  const item = document.createElement('div');
  item.className = 'editable-exercise';
  item.draggable = true;
  item.dataset.exerciseId = String(exercise.id || '');

  const nameRow = document.createElement('div');
  nameRow.className = 'editable-exercise-name';
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'drag-handle';
  handle.textContent = '☷';
  handle.title = 'Drag to reorder';
  handle.setAttribute('aria-label', `Drag ${exercise.name} to reorder`);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'exercise-name-input';
  nameInput.value = exercise.name;
  nameInput.maxLength = 120;
  nameInput.required = true;
  nameInput.setAttribute('aria-label', 'Exercise name');
  const rowActions = document.createElement('div');
  rowActions.className = 'exercise-row-actions';
  const moveUpButton = document.createElement('button');
  moveUpButton.type = 'button';
  moveUpButton.textContent = '↑';
  moveUpButton.setAttribute('aria-label', `Move ${exercise.name} up`);
  moveUpButton.addEventListener('click', () => moveEditableExercise(item, -1));
  const moveDownButton = document.createElement('button');
  moveDownButton.type = 'button';
  moveDownButton.textContent = '↓';
  moveDownButton.setAttribute('aria-label', `Move ${exercise.name} down`);
  moveDownButton.addEventListener('click', () => moveEditableExercise(item, 1));
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'remove-exercise-btn';
  removeButton.textContent = '×';
  removeButton.setAttribute('aria-label', `Remove ${exercise.name}`);
  removeButton.addEventListener('click', () => removeEditableExercise(item));
  rowActions.append(moveUpButton, moveDownButton, removeButton);
  nameRow.append(handle, nameInput, rowActions);

  const fields = document.createElement('div');
  fields.className = 'editable-exercise-fields';
  [
    { label: 'Rest (sec)', field: 'restSeconds', value: exercise.restSeconds, min: '0', step: '1' },
    { label: 'Weight (kg)', field: 'defaultWeightKg', value: exercise.defaultWeightKg, min: '0', step: '0.5' },
    { label: 'Reps', field: 'defaultReps', value: exercise.defaultReps, min: '1', step: '1' },
    { label: 'Sets', field: 'defaultSets', value: exercise.defaultSets, min: '1', step: '1' },
    { label: 'Warm-up sets', field: 'warmupSets', value: exercise.warmupSets ?? 0, min: '0', max: '10', step: '1' },
    { label: 'Warm-up rest (sec)', field: 'warmupRestSeconds', value: exercise.warmupRestSeconds ?? 45, min: '0', step: '1' },
  ].forEach(({ label, field, value, min, max, step }) => {
    const fieldLabel = document.createElement('label');
    fieldLabel.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.dataset.field = field;
    input.value = String(value);
    input.min = min;
    input.step = step;
    if (max) {
      input.max = max;
    }
    fieldLabel.append(input);
    fields.append(fieldLabel);
  });

  const noteLabel = document.createElement('label');
  noteLabel.className = 'editable-exercise-note';
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.dataset.field = 'notes';
  noteInput.value = exercise.notes || '';
  noteInput.maxLength = 500;
  noteInput.placeholder = 'Exercise note or form cue';
  noteInput.setAttribute('aria-label', 'Exercise note');
  noteLabel.append(noteInput);

  item.append(nameRow, fields, noteLabel);
  item.addEventListener('dragstart', () => {
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
  });
  item.addEventListener('dragover', (event) => {
    event.preventDefault();
    const dragging = document.querySelector('.editable-exercise.dragging');
    if (dragging && dragging !== item) {
      const bounds = item.getBoundingClientRect();
      const after = event.clientY > bounds.top + bounds.height / 2;
      item.parentElement.insertBefore(dragging, after ? item.nextSibling : item);
    }
  });
  let pointerReordering = false;
  handle.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') {
      return;
    }
    event.preventDefault();
    pointerReordering = true;
    handle.setPointerCapture(event.pointerId);
    item.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (event) => {
    if (!pointerReordering) {
      return;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest('.editable-exercise');
    if (target && target !== item && target.parentElement === item.parentElement) {
      const bounds = target.getBoundingClientRect();
      const after = event.clientY > bounds.top + bounds.height / 2;
      item.parentElement.insertBefore(item, after ? target.nextSibling : target);
    }
  });
  const finishPointerReorder = () => {
    pointerReordering = false;
    item.classList.remove('dragging');
  };
  handle.addEventListener('pointerup', finishPointerReorder);
  handle.addEventListener('pointercancel', finishPointerReorder);
  return item;
}

function enterRoutineEditMode() {
  if (!selectedRoutine) {
    return;
  }
  document.getElementById('edit-routine-name').value = selectedRoutine.name;
  const list = document.getElementById('editable-exercise-list');
  list.replaceChildren(...getExerciseDetails(selectedRoutine).map(createEditableExercise));
  document.getElementById('detail-exercise-list').hidden = true;
  document.getElementById('routine-edit-form').hidden = false;
  document.getElementById('edit-routine-btn').hidden = true;
  resetExerciseEntry();
}

function exitRoutineEditMode() {
  document.getElementById('detail-exercise-list').hidden = false;
  document.getElementById('routine-edit-form').hidden = true;
  document.getElementById('edit-routine-btn').hidden = false;
  document.getElementById('routine-edit-message').textContent = '';
  resetExerciseEntry();
}

function readEditableExercises() {
  return [...document.querySelectorAll('.editable-exercise')].map((item) => ({
    name: item.querySelector('.exercise-name-input').value.trim(),
    restSeconds: Math.max(0, Number(item.querySelector('[data-field="restSeconds"]').value) || 0),
    defaultWeightKg: Math.max(0, Number(item.querySelector('[data-field="defaultWeightKg"]').value) || 0),
    defaultReps: Math.max(1, Number(item.querySelector('[data-field="defaultReps"]').value) || 1),
    defaultSets: Math.min(
      20,
      Math.max(1, Number(item.querySelector('[data-field="defaultSets"]').value) || 1),
    ),
    warmupSets: Math.min(
      10,
      Math.max(0, Number(item.querySelector('[data-field="warmupSets"]').value) || 0),
    ),
    warmupRestSeconds: Math.max(
      0,
      Number(item.querySelector('[data-field="warmupRestSeconds"]').value) || 0,
    ),
    notes: item.querySelector('[data-field="notes"]').value.trim(),
  }));
}

async function saveRoutineEdits(event) {
  event.preventDefault();
  const message = document.getElementById('routine-edit-message');
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  const exercises = readEditableExercises();
  message.textContent = '';
  message.classList.remove('error');
  if (exercises.some((exercise) => !exercise.name)) {
    message.textContent = 'Every exercise needs a name.';
    message.classList.add('error');
    return;
  }

  submitButton.disabled = true;
  try {
    const updated = await IronStore.updateRoutine(
      selectedRoutine.id,
      document.getElementById('edit-routine-name').value,
      exercises,
    );
    selectedRoutine = updated;
    routines = routines.map((routine) => routine.id === updated.id ? updated : routine);
    exitRoutineEditMode();
    renderRoutineDetails();
    renderRoutines(routines);
    status.textContent = 'Routine updated';
  } catch (error) {
    message.textContent = error.message;
    message.classList.add('error');
  } finally {
    submitButton.disabled = false;
  }
}

function showRoutineDetails(routine) {
  selectedRoutine = routine;
  renderRoutineDetails();
  exitRoutineEditMode();
  homeView.hidden = true;
  activeWorkoutView.hidden = true;
  routineDetailsView.hidden = false;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function closeRoutineDetails() {
  selectedRoutine = null;
  resetExerciseEntry();
  routineDetailsView.hidden = true;
  homeView.hidden = false;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function createRoutineCard(routine, index) {
  const card = document.createElement('article');
  card.className = 'routine-card';

  const number = document.createElement('div');
  number.className = 'routine-number';
  number.textContent = `Routine ${String(index + 1).padStart(2, '0')}`;

  const title = document.createElement('h3');
  const titleButton = document.createElement('button');
  titleButton.type = 'button';
  titleButton.className = 'routine-title-button';
  titleButton.textContent = routine.name;
  titleButton.setAttribute('aria-label', `View ${routine.name} routine details`);
  titleButton.addEventListener('click', () => showRoutineDetails(routine));
  title.append(titleButton);

  const summary = document.createElement('p');
  summary.className = 'exercise-summary';
  summary.textContent = routine.exercises.join(' · ');

  const meta = document.createElement('div');
  meta.className = 'routine-meta';

  const count = document.createElement('span');
  count.className = 'exercise-count';
  count.textContent = `${routine.exercises.length} exercise${routine.exercises.length === 1 ? '' : 's'}`;

  const actions = document.createElement('div');
  actions.className = 'routine-card-actions';

  const detailButton = document.createElement('button');
  detailButton.type = 'button';
  detailButton.className = 'detail-button';
  detailButton.textContent = 'Details';
  detailButton.setAttribute('aria-label', `View ${routine.name} routine details`);
  detailButton.addEventListener('click', () => showRoutineDetails(routine));

  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.className = 'start-button';
  startButton.textContent = 'Start';
  startButton.addEventListener('click', () => startWorkout(routine));

  actions.append(detailButton, startButton);
  meta.append(count, actions);
  card.append(number, title, summary, meta);
  return card;
}

function renderRoutines(items) {
  routineList.replaceChildren();
  routineCount.textContent = String(items.length);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No matching routines. Try another search or create a new plan.';
    routineList.append(empty);
    return;
  }

  items.forEach((routine, index) => {
    routineList.append(createRoutineCard(routine, index));
  });
}

function filterRoutines() {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) {
    renderRoutines(routines);
    return;
  }

  renderRoutines(
    routines.filter((routine) => {
      const searchable = `${routine.name} ${routine.exercises.join(' ')}`.toLowerCase();
      return searchable.includes(query);
    }),
  );
}

function loadRoutines() {
  try {
    routines = IronStore.getRoutines();
    filterRoutines();
    status.textContent = '';
  } catch (error) {
    routineList.replaceChildren();
    status.textContent = 'Unable to load';
    console.error(error);
  }
}

async function finishWorkout() {
  const completedExercises = activeWorkout.exercises
    .map((exercise) => ({
      ...exercise,
      sets: exercise.sets.filter((set) => set.completed),
    }))
    .filter((exercise) => exercise.sets.length);

  if (!completedExercises.length) {
    workoutMessage.textContent = 'Complete at least one set before finishing.';
    workoutMessage.classList.add('error');
    return;
  }

  workoutMessage.textContent = 'Saving workout…';
  workoutMessage.classList.remove('error');
  document.getElementById('finish-workout-btn').disabled = true;

  try {
    await IronStore.addWorkoutEntries(
      completedExercises.map((exercise) => ({
        date: IronStore.localDateString(),
        name: exercise.name,
        muscleGroup: activeWorkout.name,
        sets: exercise.sets.map(({ weightKg, reps, isWarmup }) => ({
          weightKg,
          reps,
          isWarmup: Boolean(isWarmup),
        })),
        notes: exercise.notes,
      })),
    );
    returnToRoutines();
    status.textContent = 'Workout saved';
  } catch (error) {
    workoutMessage.textContent = error.message;
    workoutMessage.classList.add('error');
  } finally {
    document.getElementById('finish-workout-btn').disabled = false;
  }
}

document.getElementById('refresh-btn').addEventListener('click', loadRoutines);
document.getElementById('back-to-routines-btn').addEventListener('click', returnToRoutines);
document.getElementById('finish-workout-btn').addEventListener('click', finishWorkout);
document.getElementById('back-from-details-btn').addEventListener('click', closeRoutineDetails);
document.getElementById('start-detail-workout-btn').addEventListener('click', () => {
  if (selectedRoutine) {
    startWorkout(selectedRoutine);
  }
});
document.getElementById('edit-routine-btn').addEventListener('click', enterRoutineEditMode);
document.getElementById('cancel-routine-edit-btn').addEventListener('click', exitRoutineEditMode);
document.getElementById('routine-edit-form').addEventListener('submit', saveRoutineEdits);
document.getElementById('skip-rest-timer-btn').addEventListener('click', stopRestTimer);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && restTimerId) {
    updateRestTimer();
  }
});
document.getElementById('add-rest-time-btn').addEventListener('click', () => {
  if (!restEndsAt) {
    return;
  }
  primeAudio();
  restEndsAt = Math.max(restEndsAt, Date.now()) + 15000;
  document.getElementById('rest-timer').classList.remove('complete');
  if (!restTimerId) {
    restTimerId = window.setInterval(updateRestTimer, 250);
  }
  updateRestTimer();
});

const exerciseCatalog = document.getElementById('exercise-catalog');
const newExerciseInput = document.getElementById('new-exercise-name');

function resetExerciseEntry() {
  exerciseCatalog.value = '';
  newExerciseInput.value = '';
  const message = document.getElementById('add-exercise-message');
  message.textContent = '';
  message.classList.remove('error');
}

exerciseCatalog.addEventListener('change', () => {
  if (!exerciseCatalog.value) {
    return;
  }
  newExerciseInput.value = exerciseCatalog.value;
  newExerciseInput.focus();
});

newExerciseInput.addEventListener('input', () => {
  if (newExerciseInput.value !== exerciseCatalog.value) {
    exerciseCatalog.value = '';
  }
});

document.getElementById('add-edit-exercise-btn').addEventListener('click', () => {
  const message = document.getElementById('add-exercise-message');
  const name = newExerciseInput.value.trim();
  message.textContent = '';
  message.classList.remove('error');
  if (!name) {
    message.textContent = 'Choose an exercise or enter a name.';
    message.classList.add('error');
    newExerciseInput.focus();
    return;
  }

  const exercise = {
    name,
    restSeconds: 90,
    defaultWeightKg: 0,
    defaultReps: 10,
    defaultSets: 3,
    warmupSets: 0,
    warmupRestSeconds: 45,
    notes: '',
  };
  document.getElementById('editable-exercise-list').append(createEditableExercise(exercise));
  resetExerciseEntry();
  message.textContent = `${name} added. Save changes to keep it.`;
});

document.getElementById('search-btn').addEventListener('click', () => {
  searchWrap.hidden = !searchWrap.hidden;
  if (!searchWrap.hidden) {
    searchInput.focus();
  } else {
    searchInput.value = '';
    renderRoutines(routines);
  }
});

searchInput.addEventListener('input', filterRoutines);

document.getElementById('new-routine-btn').addEventListener('click', () => {
  formError.textContent = '';
  dialog.showModal();
  document.getElementById('routine-name').focus();
});

document.getElementById('close-dialog-btn').addEventListener('click', () => {
  dialog.close();
});

document.getElementById('data-btn').addEventListener('click', () => {
  backupMessage.textContent = '';
  backupMessage.classList.remove('error');
  dataDialog.showModal();
});

document.getElementById('close-data-dialog-btn').addEventListener('click', () => {
  dataDialog.close();
});

function setBackupMessage(text, isError = false) {
  backupMessage.textContent = text;
  backupMessage.classList.toggle('error', isError);
}

function afterDataReplaced(result) {
  closeRoutineDetailsIfOpen();
  loadRoutines();
  setBackupMessage(
    `Restored ${result.routines} routine${result.routines === 1 ? '' : 's'} and `
    + `${result.workouts} workout entr${result.workouts === 1 ? 'y' : 'ies'} on this device.`,
  );
}

function closeRoutineDetailsIfOpen() {
  if (!routineDetailsView.hidden) {
    closeRoutineDetails();
  }
}

document.getElementById('export-backup-btn').addEventListener('click', () => {
  try {
    const backup = IronStore.createBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `iron-log-backup-${IronStore.localDateString()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBackupMessage('Backup file created. Check your Downloads folder.');
  } catch (error) {
    setBackupMessage(`Unable to create backup: ${error.message}`, true);
  }
});

document.getElementById('restore-backup-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) {
    return;
  }
  if (!window.confirm('Restoring replaces all routines and workouts on this device. Continue?')) {
    setBackupMessage('Restore cancelled.');
    return;
  }

  setBackupMessage('Validating and restoring…');
  try {
    let payload;
    if (/\.db$/i.test(file.name)) {
      // Legacy SQLite backups are converted by the PC server without changing its database.
      payload = await requestJson('/api/backup/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
    } else {
      try {
        payload = JSON.parse(await file.text());
      } catch (parseError) {
        throw new Error('The backup file is not valid JSON.');
      }
    }
    afterDataReplaced(await IronStore.replaceAll(payload));
  } catch (error) {
    const message = error instanceof TypeError && /\.db$/i.test(file.name)
      ? 'Old .db backups need the PC server to be running. Use a .json backup instead.'
      : error.message;
    setBackupMessage(message, true);
  }
});

document.getElementById('import-server-btn').addEventListener('click', async () => {
  if (!window.confirm(
    'Import routines and workout history from the PC server? This replaces all data on this device.',
  )) {
    return;
  }
  setBackupMessage('Importing from PC…');
  try {
    const [routinePayload, workoutPayload] = await Promise.all([
      requestJson('/api/routines'),
      requestJson('/api/irons'),
    ]);
    afterDataReplaced(await IronStore.replaceAll({
      routines: routinePayload.items,
      workouts: workoutPayload.items,
    }));
  } catch (error) {
    const message = error instanceof TypeError
      ? 'PC server not reachable. Make sure Iron_Log.py is running and you are on the same Wi-Fi.'
      : error.message;
    setBackupMessage(message, true);
  }
});

const vibrateToggle = document.getElementById('alert-vibrate-toggle');
const soundToggle = document.getElementById('alert-sound-toggle');

function renderAlertSettings() {
  const settings = IronStore.getSettings();
  vibrateToggle.checked = settings.vibrate;
  soundToggle.checked = settings.sound;
  vibrateToggle.disabled = !('vibrate' in navigator);
  document.getElementById('vibrate-unsupported').hidden = 'vibrate' in navigator;
}

async function saveAlertSetting(changes) {
  try {
    await IronStore.updateSettings(changes);
  } catch (error) {
    setBackupMessage(`Unable to save setting: ${error.message}`, true);
  }
  renderAlertSettings();
}

vibrateToggle.addEventListener('change', () => saveAlertSetting({ vibrate: vibrateToggle.checked }));
soundToggle.addEventListener('change', () => {
  if (soundToggle.checked) {
    primeAudio(true);
  }
  saveAlertSetting({ sound: soundToggle.checked });
});
document.getElementById('test-alert-btn').addEventListener('click', () => {
  primeAudio();
  notifyRestComplete();
});

routineForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  formError.textContent = '';

  const exercises = document
    .getElementById('routine-exercises')
    .value.split('\n')
    .map((exercise) => exercise.trim())
    .filter(Boolean);

  try {
    const routine = await IronStore.createRoutine(
      document.getElementById('routine-name').value,
      exercises,
    );
    routines.push(routine);
    routineForm.reset();
    dialog.close();
    renderRoutines(routines);
    status.textContent = 'Routine saved';
  } catch (error) {
    formError.textContent = error.message;
  }
});

document.getElementById('empty-workout-btn').addEventListener('click', () => {
  startWorkout({ name: 'Empty workout', exercises: [] });
});

async function startApp() {
  status.textContent = 'Loading…';
  try {
    const { backend } = await IronStore.init();
    renderAlertSettings();
    loadRoutines();
    if (backend === 'memory') {
      status.textContent = 'Storage unavailable: data will be lost on reload';
    }
  } catch (error) {
    status.textContent = 'Unable to open storage';
    console.error(error);
  }
}

startApp();

from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.background import BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import uvicorn

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATABASE_PATH = Path(os.environ.get("IRON_LOG_DATABASE", BASE_DIR / "iron_log.db"))

app = FastAPI(
    title="Iron Log",
    description="Mobile-first gym workout tracker (data is stored on each device)",
    version="0.3.0",
)

STARTER_WORKOUTS = [
    {
        "date": "2026-10-30",
        "name": "Barbell Bench Press",
        "muscleGroup": "Chest",
        "sets": [{"weightKg": 82.5, "reps": 5}, {"weightKg": 80.0, "reps": 6}],
        "notes": "Felt strong, slow eccentric",
    },
    {
        "date": "2026-10-29",
        "name": "Back Squat",
        "muscleGroup": "Legs",
        "sets": [{"weightKg": 120.0, "reps": 5}, {"weightKg": 110.0, "reps": 8}],
        "notes": "Brace core and stay tall.",
    },
]

STARTER_ROUTINES = [
    {
        "name": "Push",
        "exercises": [
            "Incline Dumbbell Press",
            "Machine Chest Press",
            "Cable Triceps Extension",
            "Lateral Raise",
        ],
    },
    {
        "name": "Pull 1",
        "exercises": [
            "Lat Pulldown",
            "Machine Row",
            "Barbell Curl",
            "Face Pull",
        ],
    },
    {
        "name": "Legs",
        "exercises": [
            "Back Squat",
            "Romanian Deadlift",
            "Leg Press",
            "Standing Calf Raise",
        ],
    },
]


@contextmanager
def database_connection(path: Path = DATABASE_PATH) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
    finally:
        connection.close()


def insert_workout(connection: sqlite3.Connection, workout: dict[str, Any]) -> int:
    cursor = connection.execute(
        """
        INSERT INTO workouts (date, name, muscle_group, notes)
        VALUES (?, ?, ?, ?)
        """,
        (
            workout["date"],
            workout["name"],
            workout["muscleGroup"],
            workout["notes"],
        ),
    )
    workout_id = cursor.lastrowid
    if workout_id is None:
        raise RuntimeError("SQLite did not return an ID for the new workout.")

    connection.executemany(
        """
        INSERT INTO workout_sets (workout_id, position, weight_kg, reps, is_warmup)
        VALUES (?, ?, ?, ?, ?)
        """,
        [
            (
                workout_id,
                position,
                set_item["weightKg"],
                set_item["reps"],
                int(set_item.get("isWarmup", False)),
            )
            for position, set_item in enumerate(workout["sets"], start=1)
        ],
    )
    return workout_id


def insert_routine(connection: sqlite3.Connection, routine: dict[str, Any]) -> int:
    cursor = connection.execute(
        "INSERT INTO routines (name) VALUES (?)",
        (routine["name"],),
    )
    routine_id = cursor.lastrowid
    if routine_id is None:
        raise RuntimeError("SQLite did not return an ID for the new routine.")

    connection.executemany(
        """
        INSERT INTO routine_exercises (routine_id, position, name)
        VALUES (?, ?, ?)
        """,
        [
            (routine_id, position, exercise)
            for position, exercise in enumerate(routine["exercises"], start=1)
        ],
    )
    return routine_id


def initialize_database(path: Path = DATABASE_PATH, seed: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with database_connection(path) as connection, connection:
        if path == DATABASE_PATH:
            connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS app_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS routines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS routine_exercises (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                routine_id INTEGER NOT NULL,
                position INTEGER NOT NULL,
                name TEXT NOT NULL,
                rest_seconds INTEGER NOT NULL DEFAULT 90 CHECK (rest_seconds >= 0),
                default_weight_kg REAL NOT NULL DEFAULT 0 CHECK (default_weight_kg >= 0),
                default_reps INTEGER NOT NULL DEFAULT 10 CHECK (default_reps >= 1),
                default_sets INTEGER NOT NULL DEFAULT 3 CHECK (default_sets >= 1),
                warmup_sets INTEGER NOT NULL DEFAULT 0 CHECK (warmup_sets >= 0),
                warmup_rest_seconds INTEGER NOT NULL DEFAULT 45 CHECK (warmup_rest_seconds >= 0),
                notes TEXT NOT NULL DEFAULT '',
                FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE CASCADE,
                UNIQUE (routine_id, position)
            );

            CREATE TABLE IF NOT EXISTS workouts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                name TEXT NOT NULL,
                muscle_group TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS workout_sets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workout_id INTEGER NOT NULL,
                position INTEGER NOT NULL,
                weight_kg REAL NOT NULL CHECK (weight_kg >= 0),
                reps INTEGER NOT NULL CHECK (reps >= 1),
                is_warmup INTEGER NOT NULL DEFAULT 0 CHECK (is_warmup IN (0, 1)),
                FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE,
                UNIQUE (workout_id, position)
            );
            """
        )
        exercise_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(routine_exercises)")
        }
        migrations = {
            "rest_seconds": "ALTER TABLE routine_exercises ADD COLUMN rest_seconds INTEGER NOT NULL DEFAULT 90",
            "default_weight_kg": "ALTER TABLE routine_exercises ADD COLUMN default_weight_kg REAL NOT NULL DEFAULT 0",
            "default_reps": "ALTER TABLE routine_exercises ADD COLUMN default_reps INTEGER NOT NULL DEFAULT 10",
            "default_sets": "ALTER TABLE routine_exercises ADD COLUMN default_sets INTEGER NOT NULL DEFAULT 3",
            "warmup_sets": "ALTER TABLE routine_exercises ADD COLUMN warmup_sets INTEGER NOT NULL DEFAULT 0",
            "warmup_rest_seconds": "ALTER TABLE routine_exercises ADD COLUMN warmup_rest_seconds INTEGER NOT NULL DEFAULT 45",
            "notes": "ALTER TABLE routine_exercises ADD COLUMN notes TEXT NOT NULL DEFAULT ''",
        }
        for column, migration in migrations.items():
            if column not in exercise_columns:
                connection.execute(migration)

        workout_set_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(workout_sets)")
        }
        if "is_warmup" not in workout_set_columns:
            connection.execute(
                "ALTER TABLE workout_sets ADD COLUMN is_warmup INTEGER NOT NULL DEFAULT 0"
            )

        seeded = connection.execute(
            "SELECT 1 FROM app_metadata WHERE key = 'starter_data_seeded'"
        ).fetchone()
        if seed and seeded is None:
            for routine in STARTER_ROUTINES:
                insert_routine(connection, routine)
            for workout in STARTER_WORKOUTS:
                insert_workout(connection, workout)
            connection.execute(
                """
                INSERT INTO app_metadata (key, value)
                VALUES ('starter_data_seeded', '1')
                """
            )


class SetEntry(BaseModel):
    weightKg: float = Field(..., ge=0)
    reps: int = Field(..., ge=1)
    isWarmup: bool = False


class WorkoutEntry(BaseModel):
    date: str
    name: str = Field(..., min_length=1)
    muscleGroup: str = Field(..., min_length=1)
    sets: list[SetEntry] = Field(default_factory=list)
    notes: str = ""


class RoutineEntry(BaseModel):
    name: str = Field(..., min_length=1, max_length=60)
    exercises: list[str] = Field(..., min_length=1)


class RoutineExerciseEntry(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    restSeconds: int = Field(default=90, ge=0, le=3600)
    defaultWeightKg: float = Field(default=0, ge=0)
    defaultReps: int = Field(default=10, ge=1, le=1000)
    defaultSets: int = Field(default=3, ge=1, le=20)
    warmupSets: int = Field(default=0, ge=0, le=10)
    warmupRestSeconds: int = Field(default=45, ge=0, le=3600)
    notes: str = Field(default="", max_length=500)


class RoutineUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=60)
    exercises: list[RoutineExerciseEntry] = Field(..., min_length=1)


class ExerciseEntry(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    restSeconds: int = Field(default=90, ge=0, le=3600)
    defaultWeightKg: float = Field(default=0, ge=0)
    defaultReps: int = Field(default=10, ge=1, le=1000)
    defaultSets: int = Field(default=3, ge=1, le=20)
    warmupSets: int = Field(default=0, ge=0, le=10)
    warmupRestSeconds: int = Field(default=45, ge=0, le=3600)
    notes: str = Field(default="", max_length=500)


initialize_database()


def validate_database(path: Path) -> None:
    required_tables = {
        "app_metadata",
        "routines",
        "routine_exercises",
        "workouts",
        "workout_sets",
    }
    try:
        with closing(sqlite3.connect(path)) as connection:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()
            if integrity is None or integrity[0] != "ok":
                raise ValueError("SQLite integrity check failed.")

            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            exercise_columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(routine_exercises)"
                )
            }
    except (sqlite3.DatabaseError, OSError) as error:
        raise ValueError("The uploaded file is not a valid SQLite database.") from error

    missing_tables = required_tables - tables
    if missing_tables:
        missing = ", ".join(sorted(missing_tables))
        raise ValueError(f"The backup is missing required tables: {missing}.")

    required_exercise_columns = {"id", "routine_id", "position", "name"}
    missing_columns = required_exercise_columns - exercise_columns
    if missing_columns:
        missing = ", ".join(sorted(missing_columns))
        raise ValueError(f"The backup is missing routine exercise columns: {missing}.")


def remove_file(path: str) -> None:
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass


def fetch_workouts(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT
            w.id,
            w.date,
            w.name,
            w.muscle_group,
            w.notes,
            s.position,
            s.weight_kg,
            s.reps,
            s.is_warmup
        FROM workouts AS w
        LEFT JOIN workout_sets AS s ON s.workout_id = w.id
        ORDER BY w.id DESC, s.position
        """
    ).fetchall()

    workouts_by_id: dict[int, dict[str, Any]] = {}
    for row in rows:
        workout = workouts_by_id.setdefault(
            row["id"],
            {
                "id": row["id"],
                "date": row["date"],
                "name": row["name"],
                "muscleGroup": row["muscle_group"],
                "sets": [],
                "notes": row["notes"],
            },
        )
        if row["position"] is not None:
            workout["sets"].append(
                {
                    "weightKg": row["weight_kg"],
                    "reps": row["reps"],
                    "isWarmup": bool(row["is_warmup"]),
                }
            )

    return list(workouts_by_id.values())


@app.get("/api/irons")
def get_irons() -> dict[str, Any]:
    with database_connection() as connection:
        return {"items": fetch_workouts(connection)}


@app.post("/api/irons")
def create_iron(entry: WorkoutEntry) -> dict[str, Any]:
    if not entry.name.strip():
        raise HTTPException(status_code=400, detail="Lift name is required.")
    if not entry.sets:
        raise HTTPException(status_code=400, detail="Add at least one set before saving.")

    new_entry: dict[str, Any] = {
        "date": entry.date,
        "name": entry.name.strip(),
        "muscleGroup": entry.muscleGroup.strip(),
        "sets": [set_item.model_dump() for set_item in entry.sets],
        "notes": entry.notes.strip(),
    }
    with database_connection() as connection, connection:
        new_entry["id"] = insert_workout(connection, new_entry)
    return new_entry


def fetch_routines(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT
            r.id,
            r.name,
            e.position,
            e.id AS exercise_id,
            e.name AS exercise_name
            , e.rest_seconds
            , e.default_weight_kg
            , e.default_reps
            , e.default_sets
            , e.warmup_sets
            , e.warmup_rest_seconds
            , e.notes
        FROM routines AS r
        LEFT JOIN routine_exercises AS e ON e.routine_id = r.id
        ORDER BY r.id, e.position
        """
    ).fetchall()

    routines_by_id: dict[int, dict[str, Any]] = {}
    for row in rows:
        routine = routines_by_id.setdefault(
            row["id"],
            {"id": row["id"], "name": row["name"], "exercises": [], "exerciseDetails": []},
        )
        if row["exercise_name"] is not None:
            routine["exercises"].append(row["exercise_name"])
            routine["exerciseDetails"].append(
                {
                    "id": row["exercise_id"],
                    "name": row["exercise_name"],
                    "restSeconds": row["rest_seconds"],
                    "defaultWeightKg": row["default_weight_kg"],
                    "defaultReps": row["default_reps"],
                    "defaultSets": row["default_sets"],
                    "warmupSets": row["warmup_sets"],
                    "warmupRestSeconds": row["warmup_rest_seconds"],
                    "notes": row["notes"],
                }
            )

    return list(routines_by_id.values())


@app.get("/api/routines")
def get_routines() -> dict[str, Any]:
    with database_connection() as connection:
        return {"items": fetch_routines(connection)}


@app.post("/api/routines", status_code=201)
def create_routine(entry: RoutineEntry) -> dict[str, Any]:
    name = entry.name.strip()
    exercises = [exercise.strip() for exercise in entry.exercises if exercise.strip()]
    if not name:
        raise HTTPException(status_code=400, detail="Routine name is required.")
    if not exercises:
        raise HTTPException(status_code=400, detail="Add at least one exercise.")

    routine: dict[str, Any] = {
        "name": name,
        "exercises": exercises,
    }
    with database_connection() as connection, connection:
        routine["id"] = insert_routine(connection, routine)
    return routine


@app.post("/api/routines/{routine_id}/exercises", status_code=201)
def add_routine_exercise(routine_id: int, entry: ExerciseEntry) -> dict[str, Any]:
    name = entry.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Exercise name is required.")

    with database_connection() as connection, connection:
        routine = connection.execute(
            "SELECT id FROM routines WHERE id = ?",
            (routine_id,),
        ).fetchone()
        if routine is None:
            raise HTTPException(status_code=404, detail="Routine not found.")

        position = connection.execute(
            """
            SELECT COALESCE(MAX(position), 0) + 1
            FROM routine_exercises
            WHERE routine_id = ?
            """,
            (routine_id,),
        ).fetchone()[0]
        cursor = connection.execute(
            """
            INSERT INTO routine_exercises (
                routine_id, position, name, rest_seconds,
                default_weight_kg, default_reps, default_sets,
                warmup_sets, warmup_rest_seconds, notes
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                routine_id,
                position,
                name,
                entry.restSeconds,
                entry.defaultWeightKg,
                entry.defaultReps,
                entry.defaultSets,
                entry.warmupSets,
                entry.warmupRestSeconds,
                entry.notes.strip(),
            ),
        )
        exercise_id = cursor.lastrowid
        if exercise_id is None:
            raise RuntimeError("SQLite did not return an ID for the new exercise.")

    return {
        "id": exercise_id,
        "routineId": routine_id,
        "position": position,
        "name": name,
        "restSeconds": entry.restSeconds,
        "defaultWeightKg": entry.defaultWeightKg,
        "defaultReps": entry.defaultReps,
        "defaultSets": entry.defaultSets,
        "warmupSets": entry.warmupSets,
        "warmupRestSeconds": entry.warmupRestSeconds,
        "notes": entry.notes.strip(),
    }


@app.put("/api/routines/{routine_id}")
def update_routine(routine_id: int, entry: RoutineUpdate) -> dict[str, Any]:
    name = entry.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Routine name is required.")

    exercises = [
        {
            "name": exercise.name.strip(),
            "restSeconds": exercise.restSeconds,
            "defaultWeightKg": exercise.defaultWeightKg,
            "defaultReps": exercise.defaultReps,
            "defaultSets": exercise.defaultSets,
            "warmupSets": exercise.warmupSets,
            "warmupRestSeconds": exercise.warmupRestSeconds,
            "notes": exercise.notes.strip(),
        }
        for exercise in entry.exercises
    ]
    if any(not exercise["name"] for exercise in exercises):
        raise HTTPException(status_code=400, detail="Exercise names are required.")

    with database_connection() as connection, connection:
        if connection.execute(
            "SELECT 1 FROM routines WHERE id = ?", (routine_id,)
        ).fetchone() is None:
            raise HTTPException(status_code=404, detail="Routine not found.")

        connection.execute(
            "UPDATE routines SET name = ? WHERE id = ?",
            (name, routine_id),
        )
        connection.execute(
            "DELETE FROM routine_exercises WHERE routine_id = ?",
            (routine_id,),
        )
        connection.executemany(
            """
            INSERT INTO routine_exercises (
                routine_id, position, name, rest_seconds,
                default_weight_kg, default_reps, default_sets,
                warmup_sets, warmup_rest_seconds, notes
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    routine_id,
                    position,
                    exercise["name"],
                    exercise["restSeconds"],
                    exercise["defaultWeightKg"],
                    exercise["defaultReps"],
                    exercise["defaultSets"],
                    exercise["warmupSets"],
                    exercise["warmupRestSeconds"],
                    exercise["notes"],
                )
                for position, exercise in enumerate(exercises, start=1)
            ],
        )

    return {
        "id": routine_id,
        "name": name,
        "exercises": [exercise["name"] for exercise in exercises],
        "exerciseDetails": [
            {"id": None, **exercise} for exercise in exercises
        ],
    }


@app.get("/api/backup")
def export_backup(background_tasks: BackgroundTasks) -> FileResponse:
    temporary_file = tempfile.NamedTemporaryFile(
        prefix="iron-log-backup-",
        suffix=".db",
        delete=False,
    )
    temporary_file.close()
    backup_path = Path(temporary_file.name)

    try:
        with database_connection() as source, closing(
            sqlite3.connect(backup_path)
        ) as target:
            source.backup(target)
    except (sqlite3.DatabaseError, OSError):
        remove_file(str(backup_path))
        raise HTTPException(status_code=500, detail="Unable to create database backup.")

    background_tasks.add_task(remove_file, str(backup_path))
    return FileResponse(
        backup_path,
        media_type="application/vnd.sqlite3",
        filename="iron-log-backup.db",
        background=background_tasks,
    )


@app.post("/api/backup/restore")
async def restore_backup(request: Request) -> JSONResponse:
    temporary_file = tempfile.NamedTemporaryFile(
        prefix="iron-log-restore-",
        suffix=".db",
        delete=False,
    )
    temporary_file.close()
    restore_path = Path(temporary_file.name)

    try:
        restore_path.write_bytes(await request.body())
        validate_database(restore_path)
        with closing(
            sqlite3.connect(restore_path)
        ) as source, database_connection() as target:
            source.backup(target)
            target.commit()
        initialize_database()
        remove_file(str(restore_path))
    except ValueError as error:
        remove_file(str(restore_path))
        raise HTTPException(status_code=400, detail=str(error)) from error
    except sqlite3.DatabaseError as error:
        remove_file(str(restore_path))
        raise HTTPException(
            status_code=500,
            detail=f"Unable to restore database backup: {error}",
        ) from error
    except OSError as error:
        remove_file(str(restore_path))
        raise HTTPException(
            status_code=500,
            detail=f"Unable to restore database backup: {error}",
        ) from error

    return JSONResponse({"message": "Database backup restored successfully."})


@app.post("/api/backup/convert")
async def convert_backup(request: Request) -> dict[str, Any]:
    """Convert a legacy SQLite backup to JSON without touching the live database."""
    temporary_file = tempfile.NamedTemporaryFile(
        prefix="iron-log-convert-",
        suffix=".db",
        delete=False,
    )
    temporary_file.close()
    convert_path = Path(temporary_file.name)

    try:
        convert_path.write_bytes(await request.body())
        validate_database(convert_path)
        initialize_database(convert_path, seed=False)
        with database_connection(convert_path) as connection:
            routines = fetch_routines(connection)
            workouts = fetch_workouts(connection)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (sqlite3.DatabaseError, OSError) as error:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to read database backup: {error}",
        ) from error
    finally:
        for suffix in ("", "-wal", "-shm", "-journal"):
            remove_file(f"{convert_path}{suffix}")

    return {"routines": routines, "workouts": workouts}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


if __name__ == "__main__":
    uvicorn.run("Iron_Log:app", host="0.0.0.0", port=8000, reload=True)

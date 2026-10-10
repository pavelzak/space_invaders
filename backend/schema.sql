-- Safe to run again: existing leaderboard data is left untouched.
CREATE TABLE IF NOT EXISTS leaderboard_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (
        typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991
    ),
    data TEXT NOT NULL CHECK (
        typeof(data) = 'text' AND length(CAST(data AS BLOB)) <= 65536
    )
);

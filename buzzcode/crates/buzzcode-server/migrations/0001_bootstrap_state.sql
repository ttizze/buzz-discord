CREATE TABLE bootstrap_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO bootstrap_state (key, value)
VALUES ('durable-value', 'Buzzcode is ready');

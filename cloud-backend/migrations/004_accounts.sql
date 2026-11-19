CREATE TABLE accounts (
    user_id       VARCHAR(100) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    username      VARCHAR(100) NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9_.@-]{1,100}$'),
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('customer', 'admin'))
);

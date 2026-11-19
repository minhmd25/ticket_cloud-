-- =====================================================================
-- 001_init: sự kiện, hạng vé, đơn đặt, outbox gửi sang Azure
-- =====================================================================
-- gen_random_uuid() có sẵn từ PostgreSQL 13, không cần extension pgcrypto
-- (user ứng dụng trên Cloud SQL không có quyền CREATE EXTENSION).

-- ---------- Sự kiện ----------
CREATE TABLE events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title        VARCHAR(200) NOT NULL,
    description  TEXT         NOT NULL DEFAULT '',
    category     VARCHAR(50)  NOT NULL,              -- loại hình: concert, sport, conference, ...
    venue        VARCHAR(255) NOT NULL,
    start_time   TIMESTAMPTZ  NOT NULL,
    end_time     TIMESTAMPTZ  NOT NULL,
    status       VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
    image_url    TEXT,
    created_by   VARCHAR(100) NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT events_status_chk CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED')),
    CONSTRAINT events_time_chk   CHECK (end_time > start_time)
);
CREATE INDEX events_category_idx ON events (category, start_time);
CREATE INDEX events_status_idx   ON events (status, start_time);

-- ---------- Hạng vé ----------
-- Bất biến: total_quantity - available_quantity = tổng số vé trong các đơn CONFIRMED
CREATE TABLE ticket_types (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id            UUID          NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    name                VARCHAR(100)  NOT NULL,
    description         TEXT          NOT NULL DEFAULT '',
    price               NUMERIC(12,2) NOT NULL,
    total_quantity      INTEGER       NOT NULL,
    available_quantity  INTEGER       NOT NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT ticket_types_price_chk     CHECK (price >= 0),
    CONSTRAINT ticket_types_total_chk     CHECK (total_quantity >= 0),
    -- lớp bảo vệ cuối cùng: số vé còn lại không bao giờ âm hoặc vượt tổng
    CONSTRAINT ticket_types_available_chk CHECK (available_quantity >= 0 AND available_quantity <= total_quantity),
    CONSTRAINT ticket_types_name_uq       UNIQUE (event_id, name)
);
CREATE INDEX ticket_types_event_idx ON ticket_types (event_id);

-- ---------- Đơn đặt vé ----------
CREATE TABLE orders (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          VARCHAR(100)  NOT NULL,              -- định danh từ Backend tài khoản
    event_id         UUID          NOT NULL REFERENCES events(id),
    ticket_type_id   UUID          NOT NULL REFERENCES ticket_types(id),
    quantity         INTEGER       NOT NULL,
    unit_price       NUMERIC(12,2) NOT NULL,              -- giá chốt tại thời điểm đặt (lấy từ DB)
    total_amount     NUMERIC(14,2) NOT NULL,
    status           VARCHAR(20)   NOT NULL DEFAULT 'CONFIRMED',
    idempotency_key  VARCHAR(100),
    cancelled_at     TIMESTAMPTZ,
    cancelled_by     VARCHAR(100),
    cancel_reason    TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT orders_quantity_chk CHECK (quantity > 0),
    CONSTRAINT orders_amount_chk   CHECK (unit_price >= 0 AND total_amount >= 0),
    CONSTRAINT orders_status_chk   CHECK (status IN ('CONFIRMED', 'CANCELLED')),
    CONSTRAINT orders_cancel_chk   CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);
CREATE INDEX orders_user_idx        ON orders (user_id, created_at DESC);
CREATE INDEX orders_event_idx       ON orders (event_id, status, created_at DESC);
CREATE INDEX orders_ticket_type_idx ON orders (ticket_type_id, status);
-- chống bấm "đặt vé" 2 lần: cùng user + cùng Idempotency-Key chỉ tạo 1 đơn
CREATE UNIQUE INDEX orders_idempotency_uq ON orders (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ---------- Outbox: sự kiện cần gửi sang Azure ----------
-- Ghi trong CÙNG giao dịch với thay đổi đơn => không mất sự kiện.
CREATE TABLE outbox_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- = messageId gửi sang Azure (để Azure khử trùng lặp)
    seq              BIGSERIAL    NOT NULL UNIQUE,                -- thứ tự ghi
    aggregate_type   VARCHAR(50)  NOT NULL,                       -- 'order'
    aggregate_id     UUID         NOT NULL,                       -- order id
    event_type       VARCHAR(50)  NOT NULL,                       -- ORDER_CREATED | ORDER_CANCELLED
    payload          JSONB        NOT NULL,
    status           VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    attempts         INTEGER      NOT NULL DEFAULT 0,
    last_error       TEXT,
    next_attempt_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    locked_until     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    sent_at          TIMESTAMPTZ,
    CONSTRAINT outbox_status_chk CHECK (status IN ('PENDING', 'SENT', 'FAILED'))
);
CREATE INDEX outbox_pending_idx   ON outbox_events (next_attempt_at, seq) WHERE status = 'PENDING';
CREATE INDEX outbox_aggregate_idx ON outbox_events (aggregate_id, seq);

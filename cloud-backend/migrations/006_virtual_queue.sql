-- =====================================================================
-- 006_virtual_queue: hàng chờ ảo trước khi vào mua vé
-- =====================================================================

-- ---------- Cấu hình hàng chờ của từng sự kiện ----------
CREATE TABLE event_queue_settings (
    event_id        UUID PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    enabled         BOOLEAN      NOT NULL DEFAULT false,
    sale_start_at   TIMESTAMPTZ  NOT NULL,   -- giờ mở bán; trước giờ này không ai đặt được vé
    max_active      INTEGER      NOT NULL,   -- số người được ở trong trang mua cùng lúc
    access_minutes  INTEGER      NOT NULL,   -- thời gian mỗi người được mua sau khi vào
    -- lúc xếp ngẫu nhiên những người vào hàng trước giờ mở bán (chỉ làm MỘT lần)
    randomized_at   TIMESTAMPTZ,
    -- vị trí cuối cùng đã cấp; người vào sau khi đã xếp ngẫu nhiên nhận last_position + 1
    last_position   BIGINT       NOT NULL DEFAULT 0,
    updated_by      VARCHAR(100) NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT queue_max_active_chk     CHECK (max_active BETWEEN 1 AND 10000),
    CONSTRAINT queue_access_minutes_chk CHECK (access_minutes BETWEEN 1 AND 120)
);

-- ---------- Lượt xếp hàng: mỗi người MỘT dòng cho mỗi sự kiện ----------
-- WAITING  : đang chờ. position NULL = vào trước giờ mở bán, chưa được xếp ngẫu nhiên.
-- ADMITTED : được vào mua tới expires_at.
-- COMPLETED: đã đặt vé thành công trong lượt này.
-- EXPIRED  : hết giờ mua, hoặc bỏ đi (không hỏi lại trạng thái) khi đang chờ.
-- LEFT     : tự rời hàng.
-- Vào lại sau COMPLETED/EXPIRED/LEFT dùng lại đúng dòng này và đứng cuối hàng.
CREATE TABLE queue_entries (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id      UUID         NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id       VARCHAR(100) NOT NULL,
    status        VARCHAR(10)  NOT NULL DEFAULT 'WAITING',
    position      BIGINT,
    joined_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    admitted_at   TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    CONSTRAINT queue_entries_user_uq    UNIQUE (event_id, user_id),
    CONSTRAINT queue_entries_status_chk CHECK (status IN ('WAITING', 'ADMITTED', 'COMPLETED', 'EXPIRED', 'LEFT')),
    CONSTRAINT queue_entries_admit_chk  CHECK (status <> 'ADMITTED' OR (admitted_at IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX queue_entries_waiting_idx  ON queue_entries (event_id, position) WHERE status = 'WAITING';
CREATE INDEX queue_entries_admitted_idx ON queue_entries (event_id, expires_at) WHERE status = 'ADMITTED';

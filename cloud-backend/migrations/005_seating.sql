-- =====================================================================
-- 005_seating: sơ đồ ghế tự do (tọa độ x, y, góc xoay) và đặt ghế theo chỗ
-- =====================================================================
-- Mọi cột thêm vào bảng cũ đều có DEFAULT hằng => chỉ sửa metadata, không khóa bảng lâu,
-- revision cũ (không biết các cột này) vẫn chạy được trong lúc Cloud Run chuyển traffic.

-- ---------- Hạng vé: bán theo số lượng hay theo ghế ----------
-- GENERAL : như cũ, total_quantity do admin nhập.
-- ASSIGNED: mỗi vé là một ghế trên sơ đồ. total_quantity = số ghế (không bị khóa) của hạng,
--           backend tự tính lại mỗi khi sơ đồ thay đổi.
-- Bất biến vẫn giữ nguyên: total_quantity - available_quantity = tổng vé của các đơn CONFIRMED.
ALTER TABLE ticket_types
    ADD COLUMN seating VARCHAR(10) NOT NULL DEFAULT 'GENERAL',
    ADD CONSTRAINT ticket_types_seating_chk CHECK (seating IN ('GENERAL', 'ASSIGNED'));

-- ---------- Sơ đồ ghế: mỗi sự kiện tối đa một sơ đồ ----------
CREATE TABLE seat_maps (
    event_id     UUID PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    width        INTEGER          NOT NULL,                -- khung vẽ (đơn vị tùy ý, frontend tự co giãn)
    height       INTEGER          NOT NULL,
    seat_size    DOUBLE PRECISION NOT NULL DEFAULT 24,     -- đường kính một ghế, dùng để kiểm tra chồng nhau
    decorations  JSONB            NOT NULL DEFAULT '[]',   -- sân khấu, lối đi, chữ... chỉ để vẽ
    version      INTEGER          NOT NULL DEFAULT 1,      -- tăng mỗi lần sửa; dùng cho khóa lạc quan và ETag
    updated_by   VARCHAR(100)     NOT NULL,
    created_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    CONSTRAINT seat_maps_size_chk      CHECK (width BETWEEN 100 AND 20000 AND height BETWEEN 100 AND 20000),
    CONSTRAINT seat_maps_seat_size_chk CHECK (seat_size > 0 AND seat_size <= 500),
    CONSTRAINT seat_maps_version_chk   CHECK (version >= 1)
);

-- ---------- Khu ghế (nhóm ghế để hiển thị: "Khu trái", "Ban công"...) ----------
CREATE TABLE seat_sections (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id  UUID         NOT NULL REFERENCES seat_maps(event_id) ON DELETE CASCADE,
    key       VARCHAR(50)  NOT NULL,    -- mã ổn định do admin đặt, ghế tham chiếu theo mã này
    name      VARCHAR(100) NOT NULL,
    color     VARCHAR(7),               -- #RRGGBB, tùy chọn
    CONSTRAINT seat_sections_key_uq UNIQUE (event_id, key)
);

-- ---------- Ghế ----------
-- Nhãn ghế là khóa tự nhiên trong một sự kiện: lưu lại sơ đồ giữ nguyên id của ghế cùng nhãn,
-- nên ghế đã bán vẫn trỏ đúng dòng sau khi admin chỉnh vị trí.
CREATE TABLE seats (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID             NOT NULL REFERENCES seat_maps(event_id) ON DELETE CASCADE,
    section_id      UUID             REFERENCES seat_sections(id) ON DELETE SET NULL,
    ticket_type_id  UUID             NOT NULL REFERENCES ticket_types(id),
    label           VARCHAR(20)      NOT NULL,   -- vd "C12", in trên vé
    row_label       VARCHAR(20),                 -- vd "C"
    x               DOUBLE PRECISION NOT NULL,   -- tâm ghế
    y               DOUBLE PRECISION NOT NULL,
    rotation        DOUBLE PRECISION NOT NULL DEFAULT 0,   -- độ, chiều kim đồng hồ
    accessible      BOOLEAN          NOT NULL DEFAULT false, -- ghế cho người khuyết tật
    blocked         BOOLEAN          NOT NULL DEFAULT false, -- admin khóa, không bán
    CONSTRAINT seats_label_uq UNIQUE (event_id, label)
);
CREATE INDEX seats_ticket_type_idx ON seats (ticket_type_id);

-- ---------- Ghế của từng đơn ----------
-- released_at IS NULL  => ghế đang thuộc đơn (đơn CONFIRMED).
-- Hủy đơn / hủy sự kiện => đặt released_at, ghế được bán lại; dòng cũ giữ làm lịch sử.
-- seat_label chụp lại nhãn lúc đặt, để đơn cũ vẫn hiện đúng ghế dù sơ đồ đổi sau này.
CREATE TABLE order_seats (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id     UUID         NOT NULL REFERENCES orders(id),
    seat_id      UUID         REFERENCES seats(id) ON DELETE SET NULL,
    seat_label   VARCHAR(20)  NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    released_at  TIMESTAMPTZ
);
CREATE INDEX order_seats_order_idx ON order_seats (order_id);
-- LỚP BẢO VỆ CUỐI: một ghế chỉ thuộc tối đa MỘT đơn còn hiệu lực
CREATE UNIQUE INDEX order_seats_active_uq ON order_seats (seat_id) WHERE released_at IS NULL;

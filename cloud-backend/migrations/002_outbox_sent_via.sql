-- Ghi lại thông điệp được gửi qua kênh nào (mock | azure-queue).
-- Mục đích: biết CHÍNH XÁC thông điệp nào đã thật sự tới Azure
-- (vd để gửi danh sách dữ liệu thử cho người làm Azure xóa trước buổi demo).
ALTER TABLE outbox_events ADD COLUMN sent_via VARCHAR(30);
CREATE INDEX outbox_sent_via_idx ON outbox_events (sent_via) WHERE sent_via IS NOT NULL;

-- Mã nhận việc của worker outbox.
-- Mỗi lượt worker nhận một lô thì ghi một claim_token mới; chỉ lượt đang giữ đúng token
-- mới được đánh dấu SENT/FAILED. Nút "Gửi lại" không đụng tới dòng đang được gửi (lease còn hạn).
-- Cột cho phép NULL, không có DEFAULT => thêm cột chỉ sửa metadata, không khóa bảng lâu,
-- và revision cũ (không biết cột này) vẫn chạy được trong lúc chuyển traffic.
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS claim_token UUID;

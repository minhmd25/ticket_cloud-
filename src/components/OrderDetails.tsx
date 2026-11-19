import { Link } from 'react-router-dom';
import type { Order } from '../api';
import { formatCurrency, formatDateTime, formatEventTime, formatNumber } from '../lib/format';
import { StatusBadge } from './ui';

/** Bảng thông tin một đơn, dùng chung cho trang khách hàng và trang quản trị. */
export function OrderDetails({ order, eventLink, showBuyer }: { order: Order; eventLink: string; showBuyer?: boolean }) {
  const cancelledByAdmin = order.cancelledBy && order.cancelledBy !== order.userId;
  return (
    <dl className="details">
      <div>
        <dt>Mã đơn</dt>
        <dd className="code code--wrap">{order.id}</dd>
      </div>
      <div>
        <dt>Trạng thái</dt>
        <dd>
          <StatusBadge status={order.status} />
        </dd>
      </div>
      {showBuyer && (
        <div>
          <dt>Người đặt</dt>
          <dd>{order.userId}</dd>
        </div>
      )}
      <div>
        <dt>Sự kiện</dt>
        <dd>
          <Link to={eventLink}>{order.event.title}</Link>
        </dd>
      </div>
      <div>
        <dt>Thời gian diễn ra</dt>
        <dd>{formatEventTime(order.event.startTime)}</dd>
      </div>
      <div>
        <dt>Địa điểm</dt>
        <dd>{order.event.venue}</dd>
      </div>
      <div>
        <dt>Hạng vé</dt>
        <dd>{order.ticketType.name}</dd>
      </div>
      <div>
        <dt>Số lượng</dt>
        <dd>{formatNumber(order.quantity)}</dd>
      </div>
      <div>
        <dt>Đơn giá</dt>
        <dd>{formatCurrency(order.unitPrice)}</dd>
      </div>
      <div>
        <dt>Thành tiền</dt>
        <dd className="cell-strong">{formatCurrency(order.totalAmount)}</dd>
      </div>
      <div>
        <dt>Ngày đặt</dt>
        <dd>{formatDateTime(order.createdAt)}</dd>
      </div>
      {order.status === 'CONFIRMED' && (
        <div>
          <dt>Hạn hủy</dt>
          <dd>{formatDateTime(order.cancellationDeadline)}</dd>
        </div>
      )}
      {order.cancelledAt && (
        <div>
          <dt>Ngày hủy</dt>
          <dd>
            {formatDateTime(order.cancelledAt)}
            {cancelledByAdmin && <div className="muted small">Hủy bởi quản trị viên ({order.cancelledBy})</div>}
          </dd>
        </div>
      )}
      {order.cancelReason && (
        <div>
          <dt>Lý do hủy</dt>
          <dd>{order.cancelReason}</dd>
        </div>
      )}
    </dl>
  );
}

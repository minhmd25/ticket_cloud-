import { Link } from 'react-router-dom';
import type { Order } from '../api';
import { formatCurrency, formatDateTime, formatEventTime, formatNumber, sortSeats } from '../lib/format';
import { categoryIcon, Icon, StatusBadge } from './ui';

/** Bảng thông tin một đơn, dùng chung cho trang khách hàng và trang quản trị. */
export function OrderDetails({ order, eventLink, showBuyer }: { order: Order; eventLink: string; showBuyer?: boolean }) {
  const cancelledByAdmin = order.cancelledBy && order.cancelledBy !== order.userId;
  return (
    <>
      <div className={`order-hero cover--${order.event.category}`}>
        <span className="order-hero__icon" aria-hidden="true">
          <Icon name={categoryIcon(order.event.category)} />
        </span>
        <div>
          <p className="order-hero__title">{order.event.title}</p>
          <p className="order-hero__meta">
            {formatEventTime(order.event.startTime)} · {order.event.venue}
          </p>
        </div>
        <span className="order-hero__amount">{formatCurrency(order.totalAmount)}</span>
      </div>
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
      {order.seats.length > 0 && (
        <div>
          <dt>Ghế</dt>
          <dd>
            <ul className="seat-chips seat-chips--static" aria-label="Ghế của đơn">
              {sortSeats(order.seats).map((s) => (
                <li key={s.id}>{s.label}</li>
              ))}
            </ul>
            {order.status === 'CANCELLED' && <div className="muted small">Ghế đã được trả lại để bán tiếp.</div>}
          </dd>
        </div>
      )}
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
    </>
  );
}

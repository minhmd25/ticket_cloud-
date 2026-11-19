import type { Pool, PoolClient } from 'pg';
import { withTransaction, type Queryable } from '../db';
import { AppError, Errors } from '../errors';
import { validateLayout } from './geometry';
import type { SeatInput, SeatMapInput, SeatPatchInput } from './schemas';

export interface SeatDto {
  id: string;
  label: string;
  row: string | null;
  /** mã khu (sections[].key) */
  section: string | null;
  ticketTypeId: string;
  x: number;
  y: number;
  rotation: number;
  accessible: boolean;
  blocked: boolean;
}

export interface SeatMapDto {
  eventId: string;
  version: number;
  width: number;
  height: number;
  seatSize: number;
  sections: { key: string; name: string; color: string | null }[];
  decorations: unknown[];
  seats: SeatDto[];
  updatedAt: string;
}

export interface SeatStatusDto {
  eventId: string;
  /** version của sơ đồ: khác với bản frontend đang giữ => tải lại sơ đồ */
  version: number;
  /** ghế đã có người đặt */
  sold: string[];
  /** ghế admin khóa, không bán */
  blocked: string[];
}

/** ETag yếu theo version sơ đồ: kiểm tra được mà không cần tải hàng nghìn ghế */
export const seatMapEtag = (version: number) => `W/"seat-map-v${version}"`;

const MAX_DETAIL_ITEMS = 20;

/* eslint-disable @typescript-eslint/no-explicit-any */
export class SeatMapService {
  constructor(private readonly db: Pool) {}

  // ------------------------------------------------------------------
  // ĐỌC
  // ------------------------------------------------------------------
  /** version hiện tại; 404 nếu sự kiện không xem được hoặc chưa có sơ đồ */
  async currentVersion(eventId: string, publicView: boolean): Promise<number> {
    const r = await this.db.query(
      `SELECT e.status, m.version FROM events e LEFT JOIN seat_maps m ON m.event_id = e.id WHERE e.id = $1`,
      [eventId],
    );
    const row = r.rows[0];
    if (!row || (publicView && row.status !== 'PUBLISHED')) throw Errors.notFound('sự kiện', 'EVENT_NOT_FOUND');
    if (row.version === null) throw Errors.notFound('sơ đồ ghế', 'SEAT_MAP_NOT_FOUND');
    return row.version;
  }

  async get(eventId: string, publicView: boolean): Promise<SeatMapDto> {
    await this.currentVersion(eventId, publicView);
    return loadSeatMap(this.db, eventId);
  }

  async status(eventId: string, publicView: boolean): Promise<SeatStatusDto> {
    const version = await this.currentVersion(eventId, publicView);
    const r = await this.db.query(
      `SELECT s.id, s.blocked, (os.seat_id IS NOT NULL) AS sold
         FROM seats s
         LEFT JOIN order_seats os ON os.seat_id = s.id AND os.released_at IS NULL
        WHERE s.event_id = $1 AND (s.blocked OR os.seat_id IS NOT NULL)
        ORDER BY s.id`,
      [eventId],
    );
    return {
      eventId,
      version,
      sold: r.rows.filter((x) => x.sold).map((x) => x.id),
      blocked: r.rows.filter((x) => x.blocked && !x.sold).map((x) => x.id),
    };
  }

  // ------------------------------------------------------------------
  // GHI (admin)
  // ------------------------------------------------------------------
  /**
   * Lưu toàn bộ sơ đồ (thay thế). Ghế giữ nguyên id theo nhãn.
   * Khóa dòng sự kiện FOR UPDATE: đặt vé giữ FOR SHARE cùng dòng, nên trong lúc lưu sơ đồ
   * không đơn nào chen vào, và tổng vé của các hạng ASSIGNED được tính lại nhất quán.
   */
  async save(eventId: string, input: SeatMapInput, actorId: string): Promise<SeatMapDto> {
    return withTransaction(this.db, async (tx) => {
      await lockEditableEvent(tx, eventId);
      await saveInTx(tx, eventId, input, actorId);
      return loadSeatMap(tx, eventId);
    });
  }

  /** Khóa / mở khóa một số ghế. Không khóa được ghế đã bán. */
  async patchSeats(eventId: string, input: SeatPatchInput, actorId: string): Promise<{ version: number; changed: number }> {
    return withTransaction(this.db, async (tx) => {
      await lockEditableEvent(tx, eventId);
      const map = await tx.query('SELECT version FROM seat_maps WHERE event_id = $1 FOR UPDATE', [eventId]);
      if (!map.rows[0]) throw Errors.notFound('sơ đồ ghế', 'SEAT_MAP_NOT_FOUND');

      const ids = [...new Set(input.seatIds)];
      const r = await tx.query(
        `SELECT s.id, s.label,
                EXISTS (SELECT 1 FROM order_seats os WHERE os.seat_id = s.id AND os.released_at IS NULL) AS sold
           FROM seats s WHERE s.event_id = $1 AND s.id = ANY($2::uuid[])`,
        [eventId, ids],
      );
      if (r.rows.length !== ids.length) {
        const found = new Set(r.rows.map((x) => x.id));
        throw Errors.unprocessable('SEATS_NOT_FOUND', 'Có ghế không thuộc sơ đồ của sự kiện này', {
          seatIds: ids.filter((id) => !found.has(id)).slice(0, MAX_DETAIL_ITEMS),
        });
      }
      if (input.blocked) {
        const sold = r.rows.filter((x) => x.sold);
        if (sold.length) {
          throw Errors.conflict('SEAT_SOLD_LOCKED', 'Không khóa được ghế đã có người đặt', {
            seats: sold.slice(0, MAX_DETAIL_ITEMS).map((x) => ({ label: x.label, reason: 'khóa ghế đã bán' })),
          });
        }
      }
      const upd = await tx.query(`UPDATE seats SET blocked = $3 WHERE event_id = $1 AND id = ANY($2::uuid[]) AND blocked <> $3`, [
        eventId,
        ids,
        input.blocked,
      ]);
      const changed = upd.rowCount ?? 0;
      let version: number = map.rows[0].version;
      if (changed > 0) {
        const v = await tx.query(
          `UPDATE seat_maps SET version = version + 1, updated_at = now(), updated_by = $2 WHERE event_id = $1 RETURNING version`,
          [eventId, actorId],
        );
        version = v.rows[0].version;
        await recomputeAssignedTotals(tx, eventId);
      }
      return { version, changed };
    });
  }

  /**
   * Chép sơ đồ của sự kiện khác. Hạng vé được ghép theo TÊN: sự kiện đích phải có hạng ASSIGNED
   * trùng tên với mọi hạng mà ghế nguồn đang dùng. Sau đó đi qua đúng luồng lưu sơ đồ (kiểm tra như PUT).
   */
  async copyFrom(eventId: string, sourceEventId: string, version: number, actorId: string): Promise<SeatMapDto> {
    if (eventId === sourceEventId) throw Errors.badRequest('Không chép sơ đồ từ chính sự kiện này');
    return withTransaction(this.db, async (tx) => {
      await lockEditableEvent(tx, eventId);
      const src = await tx.query('SELECT * FROM seat_maps WHERE event_id = $1', [sourceEventId]);
      if (!src.rows[0]) throw Errors.notFound('sơ đồ ghế của sự kiện nguồn', 'SEAT_MAP_NOT_FOUND');
      const source = await loadSeatMap(tx, sourceEventId);

      const srcTiers = await tx.query('SELECT id, name FROM ticket_types WHERE event_id = $1', [sourceEventId]);
      const dstTiers = await tx.query(`SELECT id, name FROM ticket_types WHERE event_id = $1 AND seating = 'ASSIGNED'`, [eventId]);
      const srcName = new Map<string, string>(srcTiers.rows.map((t) => [t.id, t.name]));
      const dstByName = new Map<string, string>(dstTiers.rows.map((t) => [t.name, t.id]));
      const usedNames = [...new Set(source.seats.map((s) => srcName.get(s.ticketTypeId)!))];
      const missing = usedNames.filter((n) => !dstByName.has(n));
      if (missing.length) {
        throw Errors.unprocessable(
          'TICKET_TYPE_MAPPING_FAILED',
          'Sự kiện đích thiếu hạng vé theo ghế (ASSIGNED) trùng tên với sự kiện nguồn',
          { missing },
        );
      }

      const input: SeatMapInput = {
        version,
        width: source.width,
        height: source.height,
        seatSize: source.seatSize,
        sections: source.sections.map((s) => ({ key: s.key, name: s.name, color: s.color })),
        decorations: source.decorations as SeatMapInput['decorations'],
        seats: source.seats.map((s) => ({
          label: s.label,
          row: s.row,
          section: s.section,
          ticketTypeId: dstByName.get(srcName.get(s.ticketTypeId)!)!,
          x: s.x,
          y: s.y,
          rotation: s.rotation,
          accessible: s.accessible,
          blocked: s.blocked,
        })),
      };
      await saveInTx(tx, eventId, input, actorId);
      return loadSeatMap(tx, eventId);
    });
  }
}

// ======================================================================
// Hàm dùng chung (cũng được OrderService / EventService gọi)
// ======================================================================

async function lockEditableEvent(tx: PoolClient, eventId: string): Promise<void> {
  const ev = await tx.query('SELECT status FROM events WHERE id = $1 FOR UPDATE', [eventId]);
  if (!ev.rows[0]) throw Errors.notFound('sự kiện', 'EVENT_NOT_FOUND');
  if (ev.rows[0].status === 'CANCELLED') throw Errors.conflict('EVENT_CANCELLED', 'Sự kiện đã hủy');
}

/** Lưu sơ đồ trong giao dịch đang khóa dòng sự kiện */
async function saveInTx(tx: PoolClient, eventId: string, input: SeatMapInput, actorId: string): Promise<void> {
  const issues = validateLayout(input);
  if (issues.length) throw Errors.badRequest('Sơ đồ ghế không hợp lệ', issues);

  const cur = await tx.query('SELECT version FROM seat_maps WHERE event_id = $1 FOR UPDATE', [eventId]);
  const currentVersion: number = cur.rows[0]?.version ?? 0;
  if (input.version !== currentVersion) {
    throw Errors.conflict('SEAT_MAP_VERSION_CONFLICT', 'Sơ đồ đã bị thay đổi bởi người khác, hãy tải lại rồi sửa tiếp', {
      currentVersion,
      yourVersion: input.version,
    });
  }

  // mọi ghế phải thuộc một hạng vé ASSIGNED của chính sự kiện này
  const tiers = await tx.query('SELECT id, seating FROM ticket_types WHERE event_id = $1', [eventId]);
  const seating = new Map<string, string>(tiers.rows.map((t) => [t.id, t.seating]));
  const badTier = input.seats.filter((s) => seating.get(s.ticketTypeId) !== 'ASSIGNED');
  if (badTier.length) {
    throw Errors.unprocessable(
      'INVALID_SEAT_TICKET_TYPE',
      'Ghế phải thuộc một hạng vé bán theo ghế (seating = ASSIGNED) của sự kiện này',
      { seats: badTier.slice(0, MAX_DETAIL_ITEMS).map((s) => ({ label: s.label, ticketTypeId: s.ticketTypeId })) },
    );
  }

  // ghế đã bán: không được xóa, đổi hạng hay khóa (được phép dời vị trí)
  const existing = await tx.query(
    `SELECT s.id, s.label, s.ticket_type_id
       FROM seats s
      WHERE s.event_id = $1
        AND EXISTS (SELECT 1 FROM order_seats os WHERE os.seat_id = s.id AND os.released_at IS NULL)`,
    [eventId],
  );
  const byLabel = new Map<string, SeatInput>(input.seats.map((s) => [s.label, s]));
  const locked: { label: string; reason: string }[] = [];
  for (const s of existing.rows) {
    const next = byLabel.get(s.label);
    if (!next) locked.push({ label: s.label, reason: 'xóa ghế đã bán' });
    else if (next.ticketTypeId !== s.ticket_type_id) locked.push({ label: s.label, reason: 'đổi hạng vé của ghế đã bán' });
    else if (next.blocked) locked.push({ label: s.label, reason: 'khóa ghế đã bán' });
  }
  if (locked.length) {
    throw Errors.conflict('SEAT_SOLD_LOCKED', 'Không thể xóa, đổi hạng hoặc khóa ghế đã có người đặt', {
      seats: locked.slice(0, MAX_DETAIL_ITEMS),
      total: locked.length,
    });
  }

  await tx.query(
    `INSERT INTO seat_maps (event_id, width, height, seat_size, decorations, version, updated_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6)
     ON CONFLICT (event_id) DO UPDATE
        SET width = EXCLUDED.width, height = EXCLUDED.height, seat_size = EXCLUDED.seat_size,
            decorations = EXCLUDED.decorations, version = seat_maps.version + 1,
            updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [eventId, input.width, input.height, input.seatSize, JSON.stringify(input.decorations), actorId],
  );

  // khu ghế
  const keys = input.sections.map((s) => s.key);
  await tx.query('DELETE FROM seat_sections WHERE event_id = $1 AND NOT (key = ANY($2::text[]))', [eventId, keys]);
  if (keys.length) {
    await tx.query(
      `INSERT INTO seat_sections (event_id, key, name, color)
       SELECT $1, u.key, u.name, u.color FROM unnest($2::text[], $3::text[], $4::text[]) AS u(key, name, color)
       ON CONFLICT (event_id, key) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color`,
      [eventId, keys, input.sections.map((s) => s.name), input.sections.map((s) => s.color ?? null)],
    );
  }

  // ghế: xóa ghế không còn trong sơ đồ (chắc chắn chưa bán), rồi upsert theo nhãn
  const labels = input.seats.map((s) => s.label);
  await tx.query('DELETE FROM seats WHERE event_id = $1 AND NOT (label = ANY($2::text[]))', [eventId, labels]);
  if (labels.length) {
    await tx.query(
      `INSERT INTO seats (event_id, section_id, ticket_type_id, label, row_label, x, y, rotation, accessible, blocked)
       SELECT $1, sec.id, u.tt, u.label, u.row_label, u.x, u.y, u.rot, u.acc, u.blk
         FROM unnest($2::text[], $3::text[], $4::text[], $5::uuid[], $6::float8[], $7::float8[], $8::float8[], $9::bool[], $10::bool[])
              AS u(label, row_label, section, tt, x, y, rot, acc, blk)
         LEFT JOIN seat_sections sec ON sec.event_id = $1 AND sec.key = u.section
       ON CONFLICT (event_id, label) DO UPDATE
          SET section_id = EXCLUDED.section_id, ticket_type_id = EXCLUDED.ticket_type_id, row_label = EXCLUDED.row_label,
              x = EXCLUDED.x, y = EXCLUDED.y, rotation = EXCLUDED.rotation,
              accessible = EXCLUDED.accessible, blocked = EXCLUDED.blocked`,
      [
        eventId,
        labels,
        input.seats.map((s) => s.row ?? null),
        input.seats.map((s) => s.section ?? null),
        input.seats.map((s) => s.ticketTypeId),
        input.seats.map((s) => s.x),
        input.seats.map((s) => s.y),
        input.seats.map((s) => s.rotation),
        input.seats.map((s) => s.accessible),
        input.seats.map((s) => s.blocked),
      ],
    );
  }

  await recomputeAssignedTotals(tx, eventId);
}

/**
 * Tính lại tổng vé của các hạng ASSIGNED = số ghế không bị khóa của hạng đó.
 * Số vé đã bán (total - available) giữ nguyên, nên available = tổng mới - đã bán.
 * Ghế đã bán không bao giờ bị khóa/xóa/đổi hạng, nên tổng mới >= đã bán; CHECK ở DB là lớp bảo vệ cuối.
 */
export async function recomputeAssignedTotals(tx: Queryable, eventId: string): Promise<void> {
  await tx.query(
    `UPDATE ticket_types t
        SET available_quantity = c.n - (t.total_quantity - t.available_quantity),
            total_quantity     = c.n,
            updated_at         = now()
       FROM (SELECT tt.id, (count(s.id) FILTER (WHERE NOT s.blocked))::int AS n
               FROM ticket_types tt LEFT JOIN seats s ON s.ticket_type_id = tt.id
              WHERE tt.event_id = $1 AND tt.seating = 'ASSIGNED'
              GROUP BY tt.id) c
      WHERE t.id = c.id AND t.total_quantity <> c.n`,
    [eventId],
  );
}

export async function loadSeatMap(db: Queryable, eventId: string): Promise<SeatMapDto> {
  const m = await db.query('SELECT * FROM seat_maps WHERE event_id = $1', [eventId]);
  const map = m.rows[0];
  if (!map) throw Errors.notFound('sơ đồ ghế', 'SEAT_MAP_NOT_FOUND');
  const sections = await db.query('SELECT key, name, color FROM seat_sections WHERE event_id = $1 ORDER BY key', [eventId]);
  const seats = await db.query(
    `SELECT s.*, sec.key AS section_key
       FROM seats s LEFT JOIN seat_sections sec ON sec.id = s.section_id
      WHERE s.event_id = $1
      ORDER BY s.label`,
    [eventId],
  );
  return {
    eventId,
    version: map.version,
    width: map.width,
    height: map.height,
    seatSize: map.seat_size,
    sections: sections.rows.map((s) => ({ key: s.key, name: s.name, color: s.color })),
    decorations: map.decorations,
    seats: seats.rows.map((s: any) => ({
      id: s.id,
      label: s.label,
      row: s.row_label,
      section: s.section_key,
      ticketTypeId: s.ticket_type_id,
      x: s.x,
      y: s.y,
      rotation: s.rotation,
      accessible: s.accessible,
      blocked: s.blocked,
    })),
    updatedAt: new Date(map.updated_at).toISOString(),
  };
}

/** Dùng trong giao dịch đặt vé (đang giữ FOR SHARE dòng sự kiện): kiểm tra ghế khách chọn */
export async function checkSeatsForBooking(
  tx: Queryable,
  eventId: string,
  ticketTypeId: string,
  seatIds: string[],
): Promise<{ id: string; label: string }[]> {
  const r = await tx.query(
    `SELECT s.id, s.label, s.ticket_type_id, s.blocked,
            EXISTS (SELECT 1 FROM order_seats os WHERE os.seat_id = s.id AND os.released_at IS NULL) AS sold
       FROM seats s WHERE s.event_id = $1 AND s.id = ANY($2::uuid[])
      ORDER BY s.id`,
    [eventId, seatIds],
  );
  if (r.rows.length !== seatIds.length) {
    const found = new Set(r.rows.map((x) => x.id));
    throw Errors.unprocessable('SEATS_NOT_FOUND', 'Có ghế không thuộc sơ đồ của sự kiện này', {
      seatIds: seatIds.filter((id) => !found.has(id)).slice(0, MAX_DETAIL_ITEMS),
    });
  }
  const wrongTier = r.rows.filter((x) => x.ticket_type_id !== ticketTypeId);
  if (wrongTier.length) {
    throw Errors.unprocessable('SEAT_TICKET_TYPE_MISMATCH', 'Mỗi đơn chỉ gồm ghế của đúng hạng vé đã chọn', {
      labels: wrongTier.map((x) => x.label),
    });
  }
  const blocked = r.rows.filter((x) => x.blocked);
  if (blocked.length) {
    throw new AppError(409, 'SEAT_BLOCKED', 'Có ghế đang bị khóa, không bán', {
      seatIds: blocked.map((x) => x.id),
      labels: blocked.map((x) => x.label),
    });
  }
  const sold = r.rows.filter((x) => x.sold);
  if (sold.length) throw seatTakenError(sold);
  return r.rows.map((x) => ({ id: x.id, label: x.label }));
}

export function seatTakenError(seats: { id: string; label: string }[]): AppError {
  return Errors.conflict('SEAT_TAKEN', `Ghế ${seats.map((s) => s.label).join(', ')} vừa có người đặt, vui lòng chọn ghế khác`, {
    seatIds: seats.map((s) => s.id),
    labels: seats.map((s) => s.label),
  });
}

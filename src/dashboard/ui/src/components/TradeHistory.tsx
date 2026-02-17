import React, { useMemo, useState } from 'react';
import type { TradeData } from '../types.js';

type SortField = 'entryTimestamp' | 'pnl' | 'pnlPct' | 'pair' | 'holdingPeriodMs';
type SortDir = 'asc' | 'desc';
type PairFilter = 'All' | 'BTC-USD' | 'ETH-USD';

const PAGE_SIZE = 25;

/** Format holding period in ms to human-readable string e.g. "2h 15m", "3d 4h" */
function formatHoldingPeriod(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) return '—';

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Format Unix ms timestamp to short date/time string */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface SortableHeaderProps {
  label: string;
  field: SortField;
  currentSort: SortField;
  direction: SortDir;
  onSort: (field: SortField) => void;
}

function SortableHeader({ label, field, currentSort, direction, onSort }: SortableHeaderProps): React.ReactElement {
  const isActive = currentSort === field;
  return (
    <th className="sortable" onClick={() => onSort(field)}>
      {label}
      {isActive && (
        <span className="sort-indicator">{direction === 'asc' ? ' ▲' : ' ▼'}</span>
      )}
    </th>
  );
}

interface TradeHistoryProps {
  trades: TradeData[];
}

/**
 * Filterable and sortable trade history table with pagination.
 * - Filter by pair (All / BTC-USD / ETH-USD)
 * - Sort by any column header (toggle asc/desc)
 * - 25 trades per page with prev/next
 * - PnL colored green/red, all prices in monospace
 */
export function TradeHistory({ trades }: TradeHistoryProps): React.ReactElement {
  const [pairFilter, setPairFilter] = useState<PairFilter>('All');
  const [sortField, setSortField] = useState<SortField>('entryTimestamp');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);

  const handleSort = (field: SortField): void => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
    setPage(0);
  };

  const handleFilter = (f: PairFilter): void => {
    setPairFilter(f);
    setPage(0);
  };

  const filtered = useMemo(() => {
    let result = [...trades];

    // Filter by pair
    // Note: TradeData doesn't have a direct pair field; sessionId may encode the pair.
    // Best-effort filter: when a specific pair is selected, include trades whose sessionId
    // contains the pair string. When 'All' is selected, no filtering is applied.
    if (pairFilter !== 'All') {
      result = result.filter((t) => t.sessionId.includes(pairFilter));
    }

    // Sort
    result.sort((a, b) => {
      let aVal: number | string;
      let bVal: number | string;

      switch (sortField) {
        case 'entryTimestamp':
          aVal = a.entryTimestamp;
          bVal = b.entryTimestamp;
          break;
        case 'pnl':
          aVal = parseFloat(a.pnl ?? '0');
          bVal = parseFloat(b.pnl ?? '0');
          break;
        case 'pnlPct':
          aVal = parseFloat(a.pnlPct ?? '0');
          bVal = parseFloat(b.pnlPct ?? '0');
          break;
        case 'holdingPeriodMs':
          aVal = a.holdingPeriodMs ?? 0;
          bVal = b.holdingPeriodMs ?? 0;
          break;
        default:
          aVal = 0;
          bVal = 0;
      }

      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [trades, pairFilter, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageData = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (trades.length === 0) {
    return <div className="empty-state">No trades yet</div>;
  }

  return (
    <div>
      {/* Controls */}
      <div className="table-controls">
        <label style={{ fontSize: 12, color: '#6b7280' }}>Pair:</label>
        <select
          className="filter-select"
          value={pairFilter}
          onChange={(e) => handleFilter(e.target.value as PairFilter)}
        >
          <option value="All">All</option>
          <option value="BTC-USD">BTC-USD</option>
          <option value="ETH-USD">ETH-USD</option>
        </select>
        <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 'auto' }}>
          {filtered.length} trade{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <SortableHeader
                label="Time"
                field="entryTimestamp"
                currentSort={sortField}
                direction={sortDir}
                onSort={handleSort}
              />
              <th>Side</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>Qty</th>
              <SortableHeader
                label="PnL"
                field="pnl"
                currentSort={sortField}
                direction={sortDir}
                onSort={handleSort}
              />
              <SortableHeader
                label="PnL%"
                field="pnlPct"
                currentSort={sortField}
                direction={sortDir}
                onSort={handleSort}
              />
              <th>Fees</th>
              <SortableHeader
                label="Hold"
                field="holdingPeriodMs"
                currentSort={sortField}
                direction={sortDir}
                onSort={handleSort}
              />
            </tr>
          </thead>
          <tbody>
            {pageData.map((trade, i) => {
              const pnlNum = parseFloat(trade.pnl ?? '0');
              const pnlClass = pnlNum >= 0 ? 'text-green' : 'text-red';
              const totalFees = (
                parseFloat(trade.entryFee) + parseFloat(trade.exitFee ?? '0')
              ).toFixed(4);

              return (
                <tr key={`${trade.sessionId}-${trade.entryTimestamp}-${i}`}>
                  <td className="text-muted">{formatTime(trade.entryTimestamp)}</td>
                  <td className={trade.entrySide === 'buy' ? 'text-green' : 'text-red'}>
                    {trade.entrySide.toUpperCase()}
                  </td>
                  <td className="mono">{trade.entryPrice}</td>
                  <td className="mono">{trade.exitPrice ?? '—'}</td>
                  <td className="mono">{trade.entryQuantity}</td>
                  <td className={`mono ${pnlClass}`}>
                    {trade.pnl !== undefined
                      ? `${pnlNum >= 0 ? '+' : ''}${trade.pnl}`
                      : '—'}
                  </td>
                  <td className={`mono ${pnlClass}`}>
                    {trade.pnlPct !== undefined ? `${trade.pnlPct}%` : '—'}
                  </td>
                  <td className="mono text-muted">{totalFees}</td>
                  <td className="text-muted">
                    {formatHoldingPeriod(trade.holdingPeriodMs)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="pagination">
          <button
            className="pagination-btn"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            Prev
          </button>
          <span>
            {page + 1} / {totalPages}
          </span>
          <button
            className="pagination-btn"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

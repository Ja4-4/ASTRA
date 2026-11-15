import { STATUS, type StatusKey } from '../lib/status';

export function Sparkline({ values, status, band, width = 120, height = 28, label }: { values: number[]; status: StatusKey; band?: [number, number]; width?: number; height?: number; label: string }) {
  if (values.length < 2) return <div style={{ width, height }} className="text-[11px] text-muted">Not enough data</div>;
  const all = band ? [...values, ...band] : values;
  const min = Math.min(...all), max = Math.max(...all);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const color = STATUS[status].cssVar;
  return (
    <svg width={width} height={height} role="img" aria-label={label}>
      {band && <rect x={0} width={width} y={y(band[1])} height={Math.max(1, y(band[0]) - y(band[1]))} fill="color-mix(in srgb, var(--text) 9%, transparent)" />}
      <path d={d} fill="none" stroke={status === 'nodata' ? 'var(--nodata)' : color} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={2.5} fill={status === 'nodata' ? 'var(--nodata)' : color} />
    </svg>
  );
}

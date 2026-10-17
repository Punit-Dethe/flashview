import type { TransferSummary } from './transferProgress';
import { TransferRing } from './TransferRing';

type Props = {
  connecting: boolean;
  summary: TransferSummary;
  onReconnect: () => void;
};

/** Small persistent-while-useful status surface, shared by connection and transfers. */
export function TransferPill({ connecting, summary, onReconnect }: Props) {
  const done = summary.complete;
  const text = connecting ? 'Connecting' : done ? 'Done' : 'Uploading';
  const detail = summary.count ? done ?
    summary.count + ' ' + (summary.count === 1 ? 'file' : 'files') + ' ready' :
    summary.ready + ' of ' + summary.count + ' ready' : 'To classroom';
  return (
    <div className={'transfer-pill' + (done ? ' is-done' : '')} role="status"
      aria-label={text + ' · ' + detail}>
      {connecting ?
        <span className="transfer-pill-spinner" aria-hidden="true"/> :
        <TransferRing className="transfer-pill-ring" percent={summary.percent} complete={done}
          label={'Overall classroom upload progress: ' + Math.round(summary.percent) + '%'}/>}
      <span className="transfer-pill-copy">
        <strong>{text}</strong>
        <span>{detail}</span>
      </span>
      {connecting && <button type="button" onClick={onReconnect} className="transfer-pill-action">
        Reconnect
      </button>}
    </div>
  );
}

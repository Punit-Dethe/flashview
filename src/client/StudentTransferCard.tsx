import { TransferRing } from './TransferRing';
import { formatBytes } from './pdf/Viewer';
import { fileAccentStyle } from './fileAccent';
import type { TransferFile } from './transferProgress';
import type { CacheProgress } from './pdf/roomCache';

type Props = {
  file: TransferFile;
  progress?: CacheProgress;
  preview?: string;
  onStop: () => void;
};

export function StudentTransferCard({ file, progress, preview, onStop }: Props) {
  const done = Boolean(progress?.complete && progress?.size === file.size &&
    progress.bytes >= file.size);
  const bytes = done ? file.size : progress?.size === file.size ?
    Math.max(0, Math.min(file.size, progress.bytes)) : 0;
  const percent = done ? 100 : (bytes / Math.max(1, file.size)) * 100;
  const stopped = file.status === 'offline' || file.status === 'rejected';
  const label = done ? 'Ready on classroom computer' :
    stopped ? 'Sharing stopped' :
    file.status === 'announcing' ? 'Preparing to share…' :
    'Uploading · ' + Math.floor(percent) + '%';
  return (
    <article className={'student-file-card' + (stopped ? ' is-stopped' : '')}
      style={fileAccentStyle(file.fileId)}>
      <div className="student-file-visual">
        {preview ? <img src={preview} alt="" className="student-file-preview"/> :
          <span className="student-file-pdf-mark" aria-hidden="true">PDF</span>}
        <TransferRing percent={percent} complete={done}
          label={'Classroom cached progress for ' + file.name + ': ' + Math.round(percent) + '%' }
          className="student-file-ring"/>
      </div>
      <div className="student-file-info">
        <strong title={file.name}>{file.name}</strong>
        <p>{formatBytes(file.size)}</p>
        <div className="student-file-status">
          <span>{label}</span>
          {!done && !stopped && <span>{formatBytes(bytes)} / {formatBytes(file.size)}</span>}
        </div>
        {!done && !stopped &&
          <button type="button" className="student-file-stop" onClick={onStop}>Stop sharing</button>}
      </div>
    </article>
  );
}

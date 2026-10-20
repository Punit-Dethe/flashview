import { TransferRing } from './TransferRing';
import { formatBytes } from './formatBytes';
import { fileAccentStyle } from './fileAccent';
import { isPdfName, fileTypeLabel } from '../shared/fileTypes';
import type { TransferFile } from './transferProgress';
import type { CacheProgress } from './pdf/roomCache';

type Props = {
  file: TransferFile;
  progress?: CacheProgress;
  preview?: string;
  onStop: () => void;
};

/** Only full-cache confirmation crosses from host to phone.
 * No percentage ring or idle pulse competing with phone PDF rendering.
 */
export function StudentTransferCard({ file, progress, preview, onStop }: Props) {
  const done = Boolean(progress?.complete && progress.size === file.size &&
    progress.bytes === file.size);
  const stopped = file.status === 'offline' || file.status === 'rejected';
  const label = done ? 'Received by host' : stopped ? 'Sharing stopped' :
    file.status === 'announcing' ? 'Preparing…' : 'Sharing…';
  return (
    <article className={'student-file-card' + (stopped ? ' is-stopped' : '')}
      style={fileAccentStyle(file.fileId)}>
      <div className="student-file-visual">
        {isPdfName(file.name) && preview ? <img src={preview} alt="" className="student-file-preview"/> :
          <span className="student-file-pdf-mark" aria-hidden="true">{fileTypeLabel(file.name)}</span>}
        {done && <TransferRing percent={100} complete
          label={'Received by classroom host: ' + file.name}
          className="student-file-ring"/>}
      </div>
      <div className="student-file-info">
        <strong title={file.name}>{file.name}</strong>
        <p>{formatBytes(file.size)}</p>
        <div className="student-file-status"><span>{label}</span></div>
        {!done && !stopped &&
          <button type="button" className="student-file-stop" onClick={onStop}>Stop sharing</button>}
      </div>
    </article>
  );
}

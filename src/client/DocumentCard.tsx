import { useEffect, useState, type CSSProperties } from 'react';
import type { PdfManifest } from '../shared/protocol';
import { isPdfName, isPowerPointName } from '../shared/fileTypes';
import type { CacheProgress } from './pdf/roomCache';
import { formatBytes } from './pdf/Viewer';
import { PixelIcon, pixelKindForName } from './PixelIcon';

type Props = {
  file: PdfManifest;
  participantColor?: string;
  previewUrl?: string;
  progress?: CacheProgress;
  bytesPerSecond?: number;
  onPresent: () => void;
  onDownload: () => void;
  saving?: boolean;
};

const CIRCUMFERENCE = 2 * Math.PI * 16;

/** Layout mirrors the reference HTML: square white card, shallow tile,
 * filename row and a full-width round action underneath. */
export function DocumentCard({file,participantColor,previewUrl,progress,bytesPerSecond=0,onPresent,onDownload,saving=false}:Props) {
  const [imageState,setImageState]=useState({url:'',ready:false,failed:false});
  const [fallbackTimeout,setFallbackTimeout]=useState(false);
  const pdf=isPdfName(file.name);
  const powerpoint=isPowerPointName(file.name);
  useEffect(()=>{
    if(!pdf||previewUrl)return;
    setFallbackTimeout(false);
    const timer=setTimeout(()=>setFallbackTimeout(true),6000);
    return ()=>clearTimeout(timer);
  },[pdf,previewUrl,file.fileId]);
  const cached=Boolean(progress?.complete);
  const percent=cached?100:Math.max(0,Math.min(100,(progress?.bytes??0)/Math.max(1,file.size)*100));
  const available=pdf?(file.status==='approved'||cached):powerpoint&&cached;
  const imageFailed=imageState.url===previewUrl&&imageState.failed;
  const showingImage=pdf&&Boolean(previewUrl)&&imageState.url===previewUrl&&imageState.ready&&!imageFailed;
  const showIcon=!pdf||imageFailed||(!previewUrl&&(fallbackTimeout||file.status==='offline'));
  const progressLabel=cached?'Fully cached':Math.round(percent)+'% cached'+
    (bytesPerSecond>0?' · '+formatBytes(bytesPerSecond)+'/s':'');
  return <article className="document-row document-card" data-owner-id={file.ownerId}>
    <div className="document-card-visual">
      <div className="document-thumb" aria-hidden="true">
        {pdf&&previewUrl&&!imageFailed&&
          <img className={'document-thumb-image'+(showingImage?' is-visible':'')}
            src={previewUrl} alt="" loading="lazy" decoding="async"
            onLoad={()=>setImageState({url:previewUrl,ready:true,failed:false})}
            onError={()=>setImageState({url:previewUrl,ready:false,failed:true})}/>}
        {!showingImage&&<div className="document-thumb-placeholder">
          {showIcon?<span className="document-pdf-symbol"><PixelIcon kind={pixelKindForName(file.name)} color={participantColor}/></span>
            :<span className="document-thumb-spinner"/>}
        </div>}
      </div>
    </div>
    <div className="document-card-info">
      <h3 title={file.name}>{file.name}</h3>
      <p className="document-file-meta">
        <span className="document-file-owner" title={file.ownerName}>
          <span className="document-owner-dot" aria-hidden="true"
            style={participantColor?{backgroundColor:participantColor}:undefined}/>
          <span className="document-owner-name">{file.ownerName}</span>
        </span>
        <span className="document-file-separator" aria-hidden="true">·</span>
        <span className="document-file-size">{formatBytes(file.size)}</span>
      </p>
    </div>
    <div className={'cache-ring'+(cached?' is-complete':'')} role="progressbar"
      aria-label={'Cached progress for '+file.name}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}
      title={progressLabel}>
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle className="ring-track" cx="22" cy="22" r="16" strokeWidth="4.5" fill="none"/>
        <circle className="ring-fill" cx="22" cy="22" r="16" strokeWidth="4.5" fill="none"
          strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE*(1-percent/100)}/>
        {cached&&<path d="M16 22.5l4.1 4.1L29 17.5" stroke="currentColor" strokeWidth="3"
          strokeLinecap="round" strokeLinejoin="round" fill="none"/>}
      </svg>
    </div>
    <div className="document-card-actions">
      <button type="button"
        className={'document-card-download reference-card-action'+(cached?' ready':' busy')}
        disabled={!cached||saving} onClick={onDownload}
        aria-label={'Download '+file.name} aria-busy={saving}
        title={cached?'Save the complete original file':progressLabel}
        style={{'--p':percent+'%'} as CSSProperties}>
        <span>{saving?'Preparing…':cached?'Download ↓':'Receiving… '+Math.round(percent)+'%'}</span>
      </button>
      {(pdf||powerpoint)&&<button type="button"
        className={'document-card-open document-card-present'+(available?' ready':' is-disabled')}
        disabled={!available} onClick={onPresent}
        aria-label={'Present '+file.name}
        title={available?'Present '+file.name:(powerpoint?'Available after complete download':'Waiting for sender')}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path d="M8.5 5.5 18 12l-9.5 6.5z" fill="currentColor"/>
        </svg>
      </button>}
    </div>
  </article>;
}

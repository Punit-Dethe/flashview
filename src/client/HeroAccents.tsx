import { PixelIcon } from './PixelIcon';

/** Reuse the cards' pixel palette, shading and stepped silhouettes. */
export function HeroAccents() {
  return (
    <div className="hero-accents" aria-hidden="true">
      <div className="hero-accent hero-accent-speed">
        <PixelIcon kind="transfer"/>
      </div>
      <div className="hero-accent hero-accent-account">
        <PixelIcon kind="no-account"/>
      </div>
    </div>
  );
}

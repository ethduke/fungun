import Image from 'next/image';
import { Check } from 'lucide-react';
import './launch-motion.css';

export function LaunchGun({ confirmed = false }: { confirmed?: boolean }) {
  return (
    <span className="launch-gun" data-confirmed={confirmed} aria-hidden="true">
      <Image src="/brand/fungun-icon.png" alt="" width={30} height={30} />
      <span className="launch-gun-trail" />
      {confirmed && <span className="launch-gun-coin">$</span>}
    </span>
  );
}

/** Indeterminate activity only: motion never implies payment or confirmation. */
export function BulletProgress({
  label,
  active = true,
  complete = false,
}: {
  label: string;
  active?: boolean;
  complete?: boolean;
}) {
  return (
    <output
      className="bullet-progress"
      data-active={active && !complete}
      data-complete={complete}
      aria-live="polite"
    >
      <span className="bullet-progress-label">{label}</span>
      {complete ? (
        <Check size={16} aria-hidden="true" />
      ) : (
        <span className="bullet-progress-track" aria-hidden="true">
          <span className="bullet-progress-round" />
        </span>
      )}
    </output>
  );
}

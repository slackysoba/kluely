interface LogoProps {
  className?: string;
}

/**
 * Kluely lockup: an original Klingon-esque profile mark at the left of an
 * extended, wide-tracked wordmark with spear-point terminals — Star Trek
 * titling language, drawn as hand-authored paths.
 *
 * Monochrome: the mark and wordmark are entirely currentColor.
 */
export default function Logo({ className }: LogoProps) {
  return (
    <svg
      viewBox="0 0 316 56"
      role="img"
      aria-label="Kluely"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Kluely</title>

      {/* ---- Mark: angular profile, facing the wordmark ------------------
          Ridged crown, heavy brow, strong nose, goatee point, hair swept
          back into two blade tips. */}
      <path
        fill="currentColor"
        d="M21 54
           C18 50 17 47 17 44
           L8 48
           C5 42 4 36 6 30
           L1 26
           C4 20 8 13 14 9
           C16 7 19 6 22 6
           L24 8
           L27 4 L30 9
           L33 6 L36 11
           L38 16
           L37 20
           L42 25
           L38 28
           L45 33
           L38 37
           L40 40
           L36 42
           L39 45
           L34 47
           L36 53
           L28 50
           Z"
      />
      {/* ---- Wordmark: KLUELY --------------------------------------------
          Light extended letterforms, cap height 36, stroke 6, wide tracking.
          Spear-point blades on the K arm, L feet, E arms, and Y horns. */}
      <g transform="translate(-10 0)">
        <g stroke="currentColor" strokeWidth="6" fill="none">
          {/* K */}
          <path d="M75 10 V46" />
          <path d="M94 12 L78 28 L94 44" />
          {/* L */}
          <path d="M115 10 V43 H136" />
          {/* U */}
          <path d="M159 10 V43 H179 V10" />
          {/* E */}
          <path d="M218 13 H199 V43 H218" />
          <path d="M199 27 H212" />
          {/* L */}
          <path d="M243 10 V43 H264" />
          {/* Y */}
          <path d="M287 10 L300 27 L313 10" />
          <path d="M300 27 V46" />
        </g>
        <g fill="currentColor">
          {/* K upper-arm blade */}
          <path d="M96.1 14.1 L91.9 9.9 L100.4 5.6 Z" />
          {/* L foot blades */}
          <path d="M136 40 L136 46 L145 43 Z" />
          <path d="M264 40 L264 46 L273 43 Z" />
          {/* E arm blades */}
          <path d="M218 10 L218 16 L226 13 Z" />
          <path d="M218 40 L218 46 L226 43 Z" />
          {/* Y horn blades */}
          <path d="M289.4 8.2 L284.6 11.8 L281.5 2.9 Z" />
          <path d="M310.6 11.8 L315.4 8.2 L318.5 2.9 Z" />
        </g>
      </g>
    </svg>
  );
}

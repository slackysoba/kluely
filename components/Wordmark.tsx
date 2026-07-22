interface WordmarkProps {
  className?: string;
}

/**
 * KLUELY wordmark only — the letterform half of the original lockup in
 * Logo.tsx, for pairing with the raster head mark in public/logo.png.
 * Monochrome: entirely currentColor.
 */
export default function Wordmark({ className }: WordmarkProps) {
  return (
    <svg
      viewBox="62 0 247 56"
      aria-hidden="true"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
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

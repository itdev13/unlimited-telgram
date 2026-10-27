// Crisp, consistent 1.75-stroke line icons. size prop controls square dimensions.
const base = (size = 20) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none' });
const s = { stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' };

export const PaperPlane = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className} fill="currentColor"><path d="M21.94 4.3 2.9 11.64c-1.24.5-1.23 1.2-.22 1.5l4.87 1.52 1.88 5.77c.23.63.11.88.77.88.51 0 .74-.23 1.02-.51l2.36-2.3 4.9 3.62c.9.5 1.55.24 1.78-.84l3.2-15.1c.33-1.32-.5-1.92-1.36-1.53Z" /></svg>
);
export const Bot = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><rect x="4" y="8" width="16" height="11" rx="3" {...s} /><path d="M12 8V4M9 4h6" {...s} /><circle cx="9" cy="13" r="1.1" fill="currentColor" /><circle cx="15" cy="13" r="1.1" fill="currentColor" /><path d="M2 13v2M22 13v2" {...s} /></svg>
);
export const Phone = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" {...s} /><path d="M11 18.5h2" {...s} /></svg>
);
export const Plus = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><path d="M12 5v14M5 12h14" {...s} /></svg>
);
export const Check = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><path d="M4 12.5l5 5L20 6.5" {...s} /></svg>
);
export const CheckCircle = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><circle cx="12" cy="12" r="9" {...s} /><path d="M8.5 12.5l2.5 2.5 4.5-5" {...s} /></svg>
);
export const Spark = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" {...s} /></svg>
);
export const Bolt = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" {...s} /></svg>
);
export const Trash = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" {...s} /></svg>
);
export const ArrowRight = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><path d="M5 12h14M13 6l6 6-6 6" {...s} /></svg>
);
export const ExternalLink = ({ size = 16, className = '' }) => (
  <svg {...base(size)} className={className}><path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6v6M20 4l-9 9" {...s} /></svg>
);
export const Gear = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><circle cx="12" cy="12" r="3" {...s} /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1Z" {...s} /></svg>
);
export const Alert = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0Z" {...s} /></svg>
);
export const Clock = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><circle cx="12" cy="12" r="9" {...s} /><path d="M12 7v5l3 2" {...s} /></svg>
);
export const Lock = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><rect x="5" y="11" width="14" height="9" rx="2" {...s} /><path d="M8 11V8a4 4 0 118 0v3" {...s} /></svg>
);
export const Loader = ({ size = 22, className = '' }) => (
  <svg {...base(size)} className={`animate-spin ${className}`}><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.18" /><path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>
);
export const Book = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><path d="M4 5a2 2 0 012-2h12v16H6a2 2 0 00-2 2V5Z" {...s} /><path d="M4 19a2 2 0 012-2h12" {...s} /></svg>
);
export const Map = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" {...s} /><path d="M9 4v14M15 6v14" {...s} /></svg>
);
export const Copy = ({ size = 16, className = '' }) => (
  <svg {...base(size)} className={className}><rect x="9" y="9" width="11" height="11" rx="2" {...s} /><path d="M5 15V5a2 2 0 012-2h8" {...s} /></svg>
);
export const Life = ({ size = 20, className = '' }) => (
  <svg {...base(size)} className={className}><circle cx="12" cy="12" r="9" {...s} /><circle cx="12" cy="12" r="3.5" {...s} /><path d="M5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4" {...s} /></svg>
);

// Voyants façon tableau de bord : gris éteint, couleur normalisée une fois allumé
// (orange = à surveiller, rouge = arrêt conseillé)

type Props = { allume: boolean; couleur: "orange" | "rouge"; titre: string; clignote?: boolean };

const ICONES = {
  // symbole ISO du voyant moteur (« check engine »)
  moteur: (
    <path d="M3 10h2V8h3V6h7v2h2l2 2h1V8h2v8h-2v-2h-1l-3 3H8l-2-2H5v2H3z" />
  ),
  batterie: (
    <>
      <path d="M6 5h3v2H6zM15 5h3v2h-3z" />
      <path fillRule="evenodd" d="M2 7h20v12H2zM5 12v1.6h4V12zm11-1v1h-1v1.6h1v1h1.6v-1h1v-1.6h-1v-1z" />
    </>
  ),
  temperature: (
    <path d="M11 2h2v2h3v1.6h-3v2h3v1.6h-3v4a3.5 3.5 0 1 1-2 0zM3 19c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 2-1v1.6s-.4 1-2 1-2-1-4-1-2 1-4 1-2-1-4-1-2 1-4 1z" />
  ),
};

export function Voyant({ type, allume, couleur, titre, clignote }: Props & { type: keyof typeof ICONES }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`voyant ${allume ? `allume ${couleur}` : ""} ${allume && clignote ? "clignote" : ""}`}
      role="img"
      aria-label={`${titre} : ${allume ? "allumé" : "éteint"}`}
    >
      <title>{titre}</title>
      {ICONES[type]}
    </svg>
  );
}

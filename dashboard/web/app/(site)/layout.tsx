import Link from "next/link";

export default function LayoutSite({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="barre">
        <Link href="/" className="marque">
          <span className="logo" />
          <span>PitLabs <b>Telemetry</b></span>
        </Link>
        <nav>
          <Link href="/">Live</Link>
          <Link href="/sessions">Sessions</Link>
          <Link href="/journal">Journal</Link>
          <Link href="/dash">Dash</Link>
        </nav>
      </header>
      <main>{children}</main>
    </>
  );
}

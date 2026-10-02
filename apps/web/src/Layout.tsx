import { Link, Outlet } from 'react-router';

export function Layout() {
  return (
    <>
      <div className="banner">Demo — inga riktiga lån</div>
      <header>
        <Link to="/" className="logo">
          LoanFlow
        </Link>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}

'use client';

export default function GlobalError() {
  return (
    <html lang="en">
      <body>
        <main>
          <h1>Fungun couldn’t finish loading.</h1>
          <p role="alert">
            Please reload the page. Your local draft will be cleared. Check your
            wallet activity before repeating any transaction.
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </main>
      </body>
    </html>
  );
}

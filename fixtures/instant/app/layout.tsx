export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <a href="/">home</a>
        </nav>
        {children}
      </body>
    </html>
  )
}

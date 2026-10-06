// Size baseline only: React 19 + React Router 7 data router with the same two routes and the same
// markup shape as probe 2 (list of 20 panes, a pane screen of rows of spans). Not run, only built.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createBrowserRouter,
  Link,
  Outlet,
  RouterProvider,
  useLoaderData,
  useLocation,
  type LoaderFunctionArgs,
} from 'react-router'
import { toRows } from '../../shared/ansi-rows.ts'
import { findPane, panes } from '../../shared/fixtures.ts'

function Shell() {
  let { pathname } = useLocation()
  return (
    <div>
      <header><Link to="/">Collie</Link> <span>{pathname}</span></header>
      <main><Outlet /></main>
    </div>
  )
}
function List() {
  return <ul>{panes.map((p) => <li key={p.id}><Link to={`/pane/${p.id}`}>{p.name}</Link> <span>{p.harness}</span></li>)}</ul>
}
async function paneLoader({ params }: LoaderFunctionArgs) {
  let pane = findPane(params.id ?? '')
  if (!pane) throw new Response('Not found', { status: 404 })
  return { name: pane.name, rows: toRows(await pane.load()) }
}

function Pane() {
  let { name, rows } = useLoaderData<typeof paneLoader>()
  return (
    <section>
      <h1>{name}</h1>
      <pre style={{ whiteSpace: 'pre-wrap' }}>
        {rows.map((r) => <div key={r.key}>{r.cells.map((c, i) => <span key={i} style={c.style}>{c.text}</span>)}</div>)}
      </pre>
    </section>
  )
}
let router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <List /> },
      {
        path: 'pane/:id',
        element: <Pane />,
        loader: paneLoader,
      },
    ],
  },
])
createRoot(document.getElementById('root')!).render(<StrictMode><RouterProvider router={router} /></StrictMode>)

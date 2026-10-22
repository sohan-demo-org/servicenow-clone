import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { isAgent, useAuth } from './auth.tsx'
import { Layout } from './components/Layout.tsx'
import { Dashboard } from './pages/Dashboard.tsx'
import { FormPage } from './pages/FormPage.tsx'
import { IncidentClusters } from './pages/IncidentClusters.tsx'
import { ListPage } from './pages/ListPage.tsx'
import { Login } from './pages/Login.tsx'
import { SearchPage } from './pages/SearchPage.tsx'
import {
  PortalArticle,
  PortalCatalog,
  PortalGetHelp,
  PortalHome,
  PortalItem,
  PortalKb,
  PortalLayout,
  PortalOrderDone,
  PortalTicket,
  PortalTickets,
} from './portal/Portal.tsx'

function RequireAuth() {
  const { user } = useAuth()
  const loc = useLocation()
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />
  return <Outlet />
}

function Home() {
  const { user } = useAuth()
  return isAgent(user) ? <Dashboard /> : <Navigate to="/sp" replace />
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route path="/sp" element={<PortalLayout />}>
          <Route index element={<PortalHome />} />
          <Route path="catalog" element={<PortalCatalog />} />
          <Route path="item/:id" element={<PortalItem />} />
          <Route path="order/:id" element={<PortalOrderDone />} />
          <Route path="get-help" element={<PortalGetHelp />} />
          <Route path="tickets" element={<PortalTickets />} />
          <Route path="ticket/:table/:id" element={<PortalTicket />} />
          <Route path="kb" element={<PortalKb />} />
          <Route path="kb/:id" element={<PortalArticle />} />
        </Route>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="/list/:table" element={<ListPage />} />
          <Route path="/record/:table/:id" element={<FormPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/incident/clusters" element={<IncidentClusters />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

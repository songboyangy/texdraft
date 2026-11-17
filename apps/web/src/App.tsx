import type { User } from '@texdraft/shared';
import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { DemoBanner } from './components/DemoBanner';
import { api } from './lib/api';
import { UserContext } from './lib/user';
import { EditorPage } from './pages/Editor';
import { LoginPage } from './pages/Login';
import { ProjectsPage } from './pages/Projects';
import { AccountPage, AdminPage } from './pages/Admin';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
  }, []);

  if (user === undefined) {
    return (
      <div className="center-screen muted">
        <Loader2 size={18} className="spin" />
      </div>
    );
  }
  if (user === null) {
    return (
      <>
        <DemoBanner />
        <LoginPage onLogin={setUser} />
      </>
    );
  }

  return (
    <UserContext.Provider value={{ user, setUser }}>
      <DemoBanner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/project/:id" element={<EditorPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/admin" element={user.isAdmin ? <AdminPage /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </UserContext.Provider>
  );
}

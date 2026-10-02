import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Layout } from './Layout';
import { ApplicationPage } from './pages/ApplicationPage';
import { ApplyPage } from './pages/ApplyPage';
import { LoanPage } from './pages/LoanPage';
import './styles.css';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <ApplyPage /> },
      { path: 'applications/:id', element: <ApplicationPage /> },
      { path: 'loans/:id', element: <LoanPage /> },
      { path: '*', element: <p>Sidan finns inte.</p> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

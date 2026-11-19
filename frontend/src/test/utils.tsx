import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { api } from '../api';
import { setSession } from '../auth/session';
import { DEMO_PASSWORDS } from '../api/mock/db';

export function renderApp(path = '/') {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </MemoryRouter>,
  );
  return { user, ...view };
}

/** Đăng nhập thẳng qua API (bỏ qua màn hình) để test đi nhanh tới trang cần kiểm tra. */
export async function loginAs(username: 'alice' | 'bob' | 'admin1') {
  const password = username === 'admin1' ? DEMO_PASSWORDS.admin : DEMO_PASSWORDS.customer;
  const session = await api.login(username, password);
  setSession(session);
  return session;
}

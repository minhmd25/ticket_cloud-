import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
}

interface Options {
  /** Giữ dữ liệu cũ khi tham số thay đổi (bộ lọc), thay vì xóa trắng màn hình. */
  keepPreviousData?: boolean;
}

/**
 * Gọi một hàm bất đồng bộ khi `deps` thay đổi. Bỏ qua kết quả cũ nếu đã có lần gọi mới hơn.
 * `reload()` luôn giữ dữ liệu hiện tại trong lúc tải lại.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList, options: Options = {}) {
  const [state, setState] = useState<AsyncState<T>>({ data: undefined, error: undefined, loading: true });
  const [nonce, setNonce] = useState(0);
  const reloading = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keep = options.keepPreviousData ?? false;

  useEffect(() => {
    let active = true;
    const keepData = reloading.current || keep;
    reloading.current = false;
    setState((prev) => ({ data: keepData ? prev.data : undefined, error: undefined, loading: true }));
    fnRef.current().then(
      (data) => {
        if (active) setState({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (active) setState((prev) => ({ data: keepData ? prev.data : undefined, error, loading: false }));
      },
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => {
    reloading.current = true;
    setNonce((n) => n + 1);
  }, []);

  const setData = useCallback((data: T) => setState((prev) => ({ ...prev, data, error: undefined })), []);

  return { ...state, reload, setData };
}

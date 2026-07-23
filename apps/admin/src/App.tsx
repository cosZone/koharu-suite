import { useEffect, useState } from 'react';

interface HealthResponse {
  service: string;
  status: 'ok';
  version: string;
}

type HealthState =
  | { kind: 'loading' }
  | { kind: 'online'; health: HealthResponse }
  | { kind: 'offline' };

export function App() {
  const [healthState, setHealthState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    fetch('/api/v1/health', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Health request failed with ${response.status}`);
        }

        return response.json() as Promise<HealthResponse>;
      })
      .then((health) => {
        setHealthState({ health, kind: 'online' });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setHealthState({ kind: 'offline' });
      });

    return () => controller.abort();
  }, []);

  const label =
    healthState.kind === 'loading'
      ? '正在连接'
      : healthState.kind === 'online'
        ? `Server v${healthState.health.version} 已连接`
        : 'Server 未连接';

  return (
    <main>
      <section className="shell">
        <p className="eyebrow">KOHARU SUITE</p>
        <h1>内容会聚集在这里。</h1>
        <p className="lede">
          这是管理端的第一个可运行骨架。Telegram 归档、文章管理与发布能力会沿着路线图逐步接入。
        </p>
        <div className={`status status--${healthState.kind}`}>
          <span aria-hidden="true" className="status__dot" />
          <span>{label}</span>
        </div>
      </section>
    </main>
  );
}

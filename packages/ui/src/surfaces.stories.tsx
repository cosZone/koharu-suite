import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from './badge';
import { EmptyState } from './empty-state';
import { Kicker } from './kicker';
import { Panel, PanelHeader } from './panel';

const PanelSample = () => (
  <Panel aria-labelledby="preview-panel-title">
    <PanelHeader>
      <div>
        <Kicker>COLLECTOR</Kicker>
        <h2 id="preview-panel-title" style={{ margin: '6px 0 0' }}>
          采集状态
        </h2>
      </div>
      <Badge tone="success">运行中</Badge>
    </PanelHeader>
    <EmptyState tone="success">队列畅通，没有等待 Owner 处理的任务。</EmptyState>
  </Panel>
);

const meta = {
  component: PanelSample,
  title: 'Primitives/Surfaces',
} satisfies Meta<typeof PanelSample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const BadgeVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      <Badge>尚未运行</Badge>
      <Badge tone="success">运行中</Badge>
      <Badge tone="warning">2 个阻塞任务</Badge>
    </div>
  ),
};

export const InverseTheme: Story = {
  decorators: [
    (Story) => (
      <div data-koharu-ui-tone="inverse" style={{ padding: 24 }}>
        <Story />
      </div>
    ),
  ],
};

export const NarrowPanel: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 280 }}>
        <Story />
      </div>
    ),
  ],
};

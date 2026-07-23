import type { Preview } from '@storybook/react-vite';
import '../src/styles.css';
import './preview.css';

const preview: Preview = {
  decorators: [
    (Story) => (
      <div className="ks-story-canvas" data-koharu-ui>
        <Story />
      </div>
    ),
  ],
  parameters: {
    a11y: {
      test: 'error',
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default preview;

type Host = {
  registerCommand(definition: HostCommandDefinition): void;
  setStatus(message: string): void;
  confirmModal(options: HostConfirmModalOptions): Promise<boolean | 'cancel'>;
  showModal(options: HostModalOptions): Promise<HostModalResult>;
  log(event: string, details?: Record<string, unknown>): void;
};

type HostCommandDefinition = {
  command: string;
  description: string;
  aliases?: string[];
  handler(): Promise<void> | void;
};

type HostConfirmModalOptions = {
  title: string;
  message: string;
  details?: string[];
  defaultValue?: boolean;
  yesLabel?: string;
  noLabel?: string;
};

type HostModalItem = {
  title: string;
  subtitle?: string;
  value?: string;
  url?: string;
};

type HostModalOptions = {
  title: string;
  items: HostModalItem[];
  emptyMessage?: string;
  help?: string;
};

type HostModalResult = {
  action: 'primary' | 'secondary' | 'open' | 'refresh' | 'cancel';
  item?: HostModalItem;
  index: number;
};

const DEMO_ITEMS: HostModalItem[] = [
  {
    title: 'REMY-1453  Refine zoom logic around viewport resizes',
    subtitle: 'In Progress (Eng)  High  Due 2026-05-24  C42',
    value: 'REMY-1453',
    url: 'https://linear.app/example/issue/REMY-1453',
  },
  {
    title: 'REMY-1428  Smooth pan gestures in canvas editor',
    subtitle: 'Todo  Normal  Due -  Editor polish',
    value: 'REMY-1428',
    url: 'https://linear.app/example/issue/REMY-1428',
  },
  {
    title: 'REMY-1399  Add regression tests for zoom snapping',
    subtitle: 'Review  Low  Due 2026-05-27  C42',
    value: 'REMY-1399',
    url: 'https://linear.app/example/issue/REMY-1399',
  },
];

export function register(host: Host): void {
  host.registerCommand({
    command: 'modal demo',
    description: 'preview the host modal styles and interactions',
    aliases: ['modal'],
    handler: async () => {
      const result = await host.showModal({
        title: 'Modal Demo',
        items: DEMO_ITEMS,
        help: 'j/k arrows move  Enter/y select  u secondary  o open  r refresh  q close',
      });
      host.log('command.modal_demo.result', { action: result.action, item: result.item?.value });

      if (result.action === 'refresh') {
        const confirmed = await host.confirmModal({
          title: 'Confirm Demo',
          message: 'This is the modal confirmation style used by :pr submit.',
          details: [
            'Branch: REMY-1453-zoom-logic',
            '2 staged, 1 unstaged, 0 untracked',
            'Current PR: none found',
          ],
          defaultValue: true,
          yesLabel: 'Continue',
          noLabel: 'Cancel',
        });
        host.setStatus(`confirm demo: ${confirmed}`);
        return;
      }

      host.setStatus(result.item?.value ? `${result.action} ${result.item.value}` : result.action);
    },
  });
}

export type ChannelCommandDefinition = {
  name: string;
  description: string;
  telegram: { enabled: boolean };
  discord?: {
    type: 1;
    options: ReadonlyArray<{
      name: "text";
      description: string;
      type: 3;
      required: true;
    }>;
  };
};

const CHANNEL_COMMAND_DEFINITIONS = [
  {
    name: "ask",
    description: "Ask the AI a question",
    telegram: { enabled: true },
    discord: {
      type: 1 as const,
      options: [
        {
          name: "text" as const,
          description: "Your question",
          type: 3 as const,
          required: true as const,
        },
      ],
    },
  },
] as const satisfies readonly ChannelCommandDefinition[];

export function getChannelCommandDefinitions(): readonly ChannelCommandDefinition[] {
  return CHANNEL_COMMAND_DEFINITIONS;
}

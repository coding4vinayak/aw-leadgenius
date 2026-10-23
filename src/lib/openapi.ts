import { VERSION } from "./version";

/**
 * The API contract — what an integrator reads, and what the acceptance
 * sweep checks against the routes.
 *
 * LeadGenius is multichannel outreach: contacts and lists, sequences of
 * steps across channels, sending accounts (with warmup), merge values the
 * sends fill, A/B tests with one control, signed webhooks both ways — the
 * suite's outbound limb. A contract is a second description of that machine,
 * and second descriptions rot. This one cannot: `scripts/check-contract.mts`
 * reads every claim back out of the source that serves it. Every route that
 * answers is in here and every operation here has a route that answers; every
 * request body is compared with the app's own declared field table, so the
 * spec cannot advertise a field the door would refuse; and the version is the
 * app's version, read from the same place the landing page's badge reads it.
 */
const API_KEY = [{ apiKey: [] }];
const SESSION = [{ sessionCookie: [] }];
const SESSION_OR_KEY = [{ sessionCookie: [] }, { apiKey: [] }];
const NONE: Record<string, string[]>[] = [];

type Method = "get" | "post" | "patch" | "put" | "delete";

interface Operation {
  /** A stable name for the call — the operationId an SDK would generate. */
  id: string;
  /** One line, said the way the README says it. */
  summary: string;
  /** The auth the route enforces. */
  auth?: "key" | "session" | "session-or-key" | "none" | "stripe";
  /** Query parameters, as `[name, description]`. */
  query?: [string, string][];
  /** Path parameters, as `[name, description]` — always required, as the template is. */
  pathParams?: [string, string][];
  /** A JSON body, described as its properties — the ones the route reads. */
  body?: { description: string; properties: Record<string, { type: string; description: string; required?: boolean }> };
  /** The statuses the route can answer, with what each one carries. */
  responses?: Record<string, string>;
  /** The field table the body is checked against, by name. */
  fields?: string;
}

interface PathItem {
  get?: Operation;
  post?: Operation;
  patch?: Operation;
  put?: Operation;
  delete?: Operation;
}

const securityFor = (auth: Operation["auth"]) =>
  auth === "key" ? API_KEY : auth === "session" ? SESSION : auth === "session-or-key" ? SESSION_OR_KEY : NONE;

function op(method: Method, operation: Operation): Record<string, unknown> {
  const parameters = [
    ...(operation.pathParams ?? []).map(([name, description]) => ({
      name,
      in: "path",
      required: true,
      description,
      schema: { type: "string" },
    })),
    ...(operation.query ?? []).map(([name, description]) => ({
      name,
      in: "query",
      required: false,
      description,
      schema: { type: "string" },
    })),
  ];
  const body = operation.body
    ? {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: Object.fromEntries(
                Object.entries(operation.body.properties).map(([name, shape]) => [
                  name,
                  { type: shape.type, description: shape.description },
                ]),
              ),
              required: Object.entries(operation.body.properties)
                .filter(([, shape]) => shape.required)
                .map(([name]) => name),
            },
          },
        },
      }
    : undefined;
  const responses = Object.fromEntries(
    Object.entries(operation.responses ?? { "200": "The answer." }).map(([status, description]) => [
      status,
      { description, content: { "application/json": { schema: { type: "object" } } } },
    ]),
  );
  return {
    operationId: operation.id,
    summary: operation.summary,
    tags: [operation.id.split(".")[0]],
    ...(parameters.length ? { parameters } : {}),
    ...(body ? { requestBody: body } : {}),
    responses,
    ...(operation.auth === "key" || operation.auth === "session" || operation.auth === "session-or-key"
      ? { security: securityFor(operation.auth) }
      : {}),
  };
}

const PATHS: Record<string, PathItem> = {
  "/api/health": {
    get: {
      id: "health.get",
      summary: "Liveness. No key needed.",
      auth: "none",
      responses: { "200": "ok." },
    },
  },
  "/api/campaigns": {
    get: {
      id: "campaigns.list",
      summary: "The workspace's campaigns.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["page", "1-based page number."],
        ["limit", "Page size; it caps at 100."],
      ],
      responses: { "200": "The campaigns, with a total." },
    },
    post: {
      id: "campaigns.create",
      fields: "CAMPAIGN_CREATE",
      summary: "Create a campaign — the umbrella every sequence, enrollment and A/B test names.",
      auth: "key",
      body: {
        description: "The name and, if you have them, the dates.",
        properties: {
          name: { type: "string", description: "What the campaign is called.", required: true },
          goal: { type: "string", description: "What it should achieve." },
          startDate: { type: "string", description: "When it starts." },
          endDate: { type: "string", description: "When it ends." },
        },
      },
      responses: { "201": "The campaign." },
    },
  },
  "/api/campaigns/{id}": {
    get: {
      id: "campaigns.get",
      summary: "One campaign, with its sequences and enrollments.",
      auth: "key",
      responses: { "200": "The campaign." },
    },
    patch: {
      id: "campaigns.update",
      fields: "CAMPAIGN_PATCH",
      summary: "Edit a campaign's name, dates, goal or lifecycle status.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          name: { type: "string", description: "A new name." },
          goal: { type: "string", description: "A new goal." },
          startDate: { type: "string", description: "A new start." },
          endDate: { type: "string", description: "A new end." },
          status: { type: "string", description: "A campaign status." },
        },
      },
      responses: { "200": "The campaign as it now reads." },
    },
    delete: {
      id: "campaigns.delete",
      summary: "Delete a campaign.",
      auth: "key",
      responses: { "200": "The campaign is gone." },
    },
  },
  "/api/sequences": {
    get: {
      id: "sequences.list",
      summary: "The workspace's sequences.",
      auth: "key",
      query: [["workspaceId", "The workspace to read. Defaults to the key's own."]],
      responses: { "200": "The sequences." },
    },
    post: {
      id: "sequences.create",
      fields: "SEQUENCE_CREATE",
      summary: "Create a sequence — its channel and the stepsConfig that engine reads back.",
      auth: "key",
      body: {
        description: "The name, the channel, and the steps.",
        properties: {
          name: { type: "string", description: "What the sequence is called.", required: true },
          description: { type: "string", description: "What it is for." },
          channel: { type: "string", description: "The sequence's channel.", required: true },
          stepsConfig: { type: "array", description: "The steps — each a {stepNumber, channel, templateId?, delayDays, delayHours, conditions?} entry; a step without stepNumber sorts nowhere." },
          campaignId: { type: "string", description: "A campaign to link the sequence into, in the same request." },
        },
      },
      responses: { "201": "The sequence, its steps as rows." },
    },
  },
  "/api/sequences/{id}": {
    get: {
      id: "sequences.get",
      summary: "One sequence.",
      auth: "key",
      responses: { "200": "The sequence." },
    },
    patch: {
      id: "sequences.update",
      fields: "SEQUENCE_PATCH",
      summary: "Edit a sequence's name, description, channel or status — the steps are the create door's.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          name: { type: "string", description: "A new name." },
          description: { type: "string", description: "What it is for." },
          channel: { type: "string", description: "A new channel." },
          status: { type: "string", description: "A sequence status." },
        },
      },
      responses: { "200": "The sequence as it now reads." },
    },
    delete: {
      id: "sequences.delete",
      summary: "Delete a sequence.",
      auth: "key",
      responses: { "200": "The sequence is gone." },
    },
  },
  "/api/templates": {
    get: {
      id: "templates.list",
      summary: "The workspace's templates.",
      auth: "key",
      query: [["workspaceId", "The workspace to read. Defaults to the key's own."]],
      responses: { "200": "The templates." },
    },
    post: {
      id: "templates.create",
      fields: "TEMPLATE_CREATE",
      summary: "Create a template — the body the steps send, with merge tokens the enrollment fills.",
      auth: "key",
      body: {
        description: "The name, channel, body and tokens.",
        properties: {
          name: { type: "string", description: "What the template is called.", required: true },
          channel: { type: "string", description: "The template's channel." },
          body: { type: "string", description: "The message — up to 50k characters.", required: true },
          subject: { type: "string", description: "The email subject line, when the channel has one." },
          variables: { type: "object", description: "The tokens the template declares." },
        },
      },
      responses: { "201": "The template." },
    },
  },
  "/api/templates/{id}": {
    get: {
      id: "templates.get",
      summary: "One template.",
      auth: "key",
      responses: { "200": "The template." },
    },
    patch: {
      id: "templates.update",
      fields: "TEMPLATE_PATCH",
      summary: "Edit a template.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          name: { type: "string", description: "A new name." },
          channel: { type: "string", description: "A new channel." },
          body: { type: "string", description: "A new body." },
          subject: { type: "string", description: "A new subject." },
          variables: { type: "object", description: "New tokens." },
        },
      },
      responses: { "200": "The template as it now reads." },
    },
    delete: {
      id: "templates.delete",
      summary: "Delete a template.",
      auth: "key",
      responses: { "200": "The template is gone." },
    },
  },
  "/api/contacts": {
    get: {
      id: "contacts.list",
      summary: "The workspace's contacts.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["status", "One contact status."],
        ["page", "1-based page number."],
        ["limit", "Page size; it caps at 100."],
      ],
      responses: { "200": "The contacts, with a total." },
    },
    post: {
      id: "contacts.create",
      fields: "CONTACT_CREATE",
      summary: "Capture one contact.",
      auth: "key",
      body: {
        description: "The contact's fields — every one optional; a person you met with no address is still a person.",
        properties: {
          email: { type: "string", description: "An address, or leave it out." },
          phone: { type: "string", description: "A phone number." },
          linkedinUrl: { type: "string", description: "A profile URL." },
          firstName: { type: "string", description: "Given name." },
          lastName: { type: "string", description: "Family name." },
          company: { type: "string", description: "The company." },
          title: { type: "string", description: "The title." },
          customFields: { type: "object", description: "Anything else this workspace keeps." },
        },
      },
      responses: { "201": "The contact." },
    },
  },
  "/api/contacts/{id}": {
    get: {
      id: "contacts.get",
      summary: "One contact, with what has been sent to them.",
      auth: "key",
      responses: { "200": "The contact." },
    },
    patch: {
      id: "contacts.update",
      fields: "CONTACT_PATCH",
      summary: "Edit a contact, including the lifecycle status.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          email: { type: "string", description: "A new address." },
          phone: { type: "string", description: "A new number." },
          linkedinUrl: { type: "string", description: "A new profile URL." },
          firstName: { type: "string", description: "A new given name." },
          lastName: { type: "string", description: "A new family name." },
          company: { type: "string", description: "A new company." },
          title: { type: "string", description: "A new title." },
          customFields: { type: "object", description: "New extras." },
          status: { type: "string", description: "The lifecycle value." },
        },
      },
      responses: { "200": "The contact as it now reads." },
    },
    post: {
      id: "contacts.enrich",
      summary: "Enrich this contact — ?action=enrich.",
      auth: "key",
      query: [["action", "enrich — the only action."]],
      responses: { "200": "What was found, or how it went." },
    },
    delete: {
      id: "contacts.delete",
      summary: "Forget a contact.",
      auth: "key",
      responses: { "200": "The contact is gone." },
    },
  },
  "/api/contact-lists": {
    get: {
      id: "contactLists.list",
      summary: "The workspace's contact lists.",
      auth: "key",
      query: [["workspaceId", "The workspace to read. Defaults to the key's own."]],
      responses: { "200": "The lists." },
    },
    post: {
      id: "contactLists.create",
      fields: "CONTACT_LIST_CREATE",
      summary: "Create a contact list — static, or dynamic with a filter.",
      auth: "key",
      body: {
        description: "The name and, for a dynamic list, the filter.",
        properties: {
          name: { type: "string", description: "What the list is called.", required: true },
          description: { type: "string", description: "What it is for." },
          isDynamic: { type: "boolean", description: "A dynamic list re-evaluates its filter." },
          filterJson: { type: "object", description: "The filter." },
        },
      },
      responses: { "201": "The list." },
    },
  },
  "/api/sending-accounts": {
    get: {
      id: "sendingAccounts.list",
      summary: "The workspace's sending accounts.",
      auth: "key",
      query: [["workspaceId", "The workspace to read. Defaults to the key's own."]],
      responses: { "200": "The accounts." },
    },
    post: {
      id: "sendingAccounts.create",
      fields: "SENDING_ACCOUNT_CREATE",
      summary: "Connect a sending account — one address per channel, with its daily limit and warmup state.",
      auth: "key",
      body: {
        description: "The name, the channel and provider, the connection's own config.",
        properties: {
          name: { type: "string", description: "What the account is called.", required: true },
          channel: { type: "string", description: "The channel it sends on." },
          provider: { type: "string", description: "The provider that does the sending." },
          config: { type: "object", description: "The connection — the provider's own settings.", required: true },
          dailyLimit: { type: "number", description: "1 to 100000." },
          warmupEnabled: { type: "boolean", description: "Whether warmup ramps the daily limit." },
          isDefault: { type: "boolean", description: "Whether this is the channel's default sender." },
        },
      },
      responses: { "201": "The account." },
    },
  },
  "/api/sending-accounts/{id}": {
    get: {
      id: "sendingAccounts.get",
      summary: "One sending account, with its warmup state.",
      auth: "key",
      responses: { "200": "The account." },
    },
    patch: {
      id: "sendingAccounts.update",
      fields: "SENDING_ACCOUNT_PATCH",
      summary: "Edit an account — its config, limits, warmup state. The provider does not change: delete and re-create.",
      auth: "key",
      body: {
        description: "The fields to change — deliberately not the channel or the provider.",
        properties: {
          name: { type: "string", description: "A new name." },
          config: { type: "object", description: "A new connection." },
          dailyLimit: { type: "number", description: "A new limit, 1 to 100000." },
          warmupEnabled: { type: "boolean", description: "Whether warmup ramps it." },
          isDefault: { type: "boolean", description: "Whether it is the channel's default." },
          isActive: { type: "boolean", description: "Whether it sends at all." },
        },
      },
      responses: { "200": "The account as it now reads." },
    },
    post: {
      id: "sendingAccounts.warmup",
      summary: "Warm this account — ?action=warmup runs one now, ?action=schedule-warmup puts it on the engine's cadence.",
      auth: "key",
      query: [["action", "warmup — send one now; schedule-warmup — take the engine's cadence."]],
      responses: { "200": "What the warmup did." },
    },
    delete: {
      id: "sendingAccounts.delete",
      summary: "Disconnect a sending account.",
      auth: "key",
      responses: { "200": "The account is gone." },
    },
  },
  "/api/enrollments": {
    post: {
      id: "enrollments.create",
      fields: "ENROLLMENT_CREATE",
      summary: "Put a contact into a sequence — with the merge values this prospect's sends fill.",
      auth: "key",
      body: {
        description: "The contact, the sequence, and the merge values.",
        properties: {
          contactId: { type: "string", description: "Who goes in.", required: true },
          sequenceId: { type: "string", description: "Which sequence.", required: true },
          campaignId: { type: "string", description: "Under which campaign." },
          metadata: { type: "object", description: "The merge values the contact row cannot hold — objects only, not a list." },
        },
      },
      responses: { "201": "The enrollment." },
    },
  },
  "/api/enrollments/{id}": {
    get: {
      id: "enrollments.get",
      summary: "One enrollment — which step it stands on, and what comes next.",
      auth: "key",
      responses: { "200": "The enrollment." },
    },
    patch: {
      id: "enrollments.update",
      fields: "ENROLLMENT_PATCH",
      summary: "Move an enrollment's lifecycle or fix its merge values — the engine keeps the step and the timing.",
      auth: "key",
      body: {
        description: "The fields to change — neither nextActionAt nor currentStep is yours.",
        properties: {
          status: { type: "string", description: "An enrollment status; leaving it out does not resend ACTIVE to restart a step." },
          metadata: { type: "object", description: "The merge values, corrected before the next step reads them." },
        },
      },
      responses: { "200": "The enrollment as it now reads." },
    },
    delete: {
      id: "enrollments.delete",
      summary: "Take a contact out of a sequence.",
      auth: "key",
      responses: { "200": "The enrollment is gone." },
    },
  },
  "/api/abtests": {
    post: {
      id: "abtests.create",
      fields: "ABTEST_CREATE",
      summary: "Start an A/B test on a campaign — two or more variants, exactly one control, weights summing to 100.",
      auth: "key",
      body: {
        description: "The test and its variants — the cross-entry rules are the route's.",
        properties: {
          campaignId: { type: "string", description: "The campaign the test belongs to.", required: true },
          name: { type: "string", description: "What the test is called.", required: true },
          hypothesis: { type: "string", description: "What you expect to be true.", required: true },
          variants: { type: "array", description: "2 to 10 — each {name, weight, isControl, sequenceId, templateId?}; names unique, exactly one control, weights summing to 100.", required: true },
        },
      },
      responses: { "201": "The test, from its next enrollment." },
    },
  },
  "/api/abtests/{id}": {
    patch: {
      id: "abtests.update",
      fields: "ABTEST_PATCH",
      summary: "Mark a test's outcome — the winner by name, and a status; DRAFT is not a destination.",
      auth: "key",
      body: {
        description: "The outcome.",
        properties: {
          status: { type: "string", description: "A test status — not DRAFT.", required: true },
          winningVariant: { type: "string", description: "The winner's name; the route checks it against the test's own variants." },
        },
      },
      responses: { "200": "The test as it now reads." },
    },
  },
  "/api/ai/draft-reply": {
    post: {
      id: "ai.draftReply",
      fields: "AI_DRAFT_REPLY",
      summary: "Draft a reply to a prospect's message — reads the enrollment, answers with a suggestion.",
      auth: "key",
      body: {
        description: "The enrollment and what you want the draft to know.",
        properties: {
          enrollmentId: { type: "string", description: "The thread.", required: true },
          reply: { type: "string", description: "The prospect's message, to draft against.", required: true },
          productContext: { type: "string", description: "What your product is, in prose." },
          knownFacts: { type: "array", description: "Facts the draft can quote." },
          model: { type: "string", description: "The model to draft with." },
        },
      },
      responses: { "200": "The draft, or why there is none." },
    },
  },
  "/api/analytics/{workspaceId}": {
    get: {
      id: "analytics.read",
      summary: "The workspace's outreach numbers — sends, replies, bounces, per campaign or sequence.",
      auth: "key",
      pathParams: [["workspaceId", "The workspace to read; the key's own is accepted."]],
      query: [
        ["date", "One day."],
        ["startDate", "A range's start."],
        ["endDate", "A range's end."],
        ["type", "One activity type."],
        ["campaignId", "Only one campaign's numbers."],
        ["sequenceId", "Only one sequence's numbers."],
      ],
      responses: { "200": "The numbers." },
    },
  },
  "/api/webhooks": {
    get: {
      id: "webhooks.list",
      summary: "The outbound subscriptions, with their signing secret previewed.",
      auth: "key",
      query: [["workspaceId", "The workspace to read. Defaults to the key's own."]],
      responses: { "200": "The subscriptions." },
    },
    post: {
      id: "webhooks.create",
      fields: "WEBHOOK_CREATE",
      summary: "Subscribe an address to events — each delivery is signed (X-LeadGenius-Signature).",
      auth: "key",
      body: {
        description: "Where to deliver, and which events.",
        properties: {
          url: { type: "string", description: "Where the deliveries go.", required: true },
          events: { type: "array", description: "The event names — an array or a comma string." },
        },
      },
      responses: { "201": "The subscription, with the signing secret returned once." },
    },
  },
  "/api/webhooks/{id}": {
    get: {
      id: "webhooks.get",
      summary: "One subscription.",
      auth: "key",
      responses: { "200": "The subscription." },
    },
    patch: {
      id: "webhooks.update",
      fields: "WEBHOOK_PATCH",
      summary: "Edit a subscription's address or state.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          url: { type: "string", description: "A new address." },
          isActive: { type: "boolean", description: "Whether it still delivers." },
        },
      },
      responses: { "200": "The subscription as it now reads." },
    },
    delete: {
      id: "webhooks.delete",
      summary: "Unsubscribe.",
      auth: "key",
      responses: { "200": "The subscription is gone." },
    },
  },
  "/api/webhooks/email": {
    post: {
      id: "webhooks.emailInbound",
      summary: "A delivery event from SendGrid, Mailgun or Postmark — a signed callback over the adapter's normalised event.",
      auth: "none",
      body: {
        description: "SendGrid/Mailgun post one event; Postmark posts several — take `events: [...]`, each {messageId (required), event (required), email, timestamp, metadata}.",
        properties: {
          events: { type: "array", description: "The normalised events." },
        },
      },
      responses: { "200": "The events were recorded or ignored; 401 for a wrong signature." },
    },
  },
  "/api/webhooks/linkedin": {
    post: {
      id: "webhooks.linkedinInbound",
      summary: "An inbound LinkedIn message — a signed callback; the sender's URN decides which contact the reply joins.",
      auth: "none",
      body: {
        description: "The adapter's normalised event.",
        properties: {
          messageId: { type: "string", description: "The provider's id — the lookup key.", required: true },
          from: { type: "string", description: "urn:li:person:… — the contact the reply joins.", required: true },
          content: { type: "string", description: "The message; absent on a status callback." },
        },
      },
      responses: { "200": "The message joined its contact; 401 for a wrong signature." },
    },
  },
  "/api/webhooks/whatsapp": {
    post: {
      id: "webhooks.whatsappInbound",
      summary: "An inbound WhatsApp message from Twilio — urlencoded on the wire, normalised before it is judged; the sender decides which contact the reply joins.",
      auth: "none",
      body: {
        description: "The same fields LinkedIn's callback carries, however the provider posts them (Twilio posts them urlencoded).",
        properties: {
          messageId: { type: "string", description: "The provider's id — the lookup key.", required: true },
          from: { type: "string", description: "whatsapp:+1555… — the contact the reply joins.", required: true },
          content: { type: "string", description: "The message; absent on a status callback." },
        },
      },
      responses: { "200": "The message joined its contact; 401 for a wrong signature." },
    },
  },
  "/api/webhooks/events": {
    post: {
      id: "webhooks.eventsRequeue",
      fields: "EVENTS_ENVELOPE",
      summary: "Re-queue one event to the subscribers — the envelope names the event; the rest of the body is the subscriber's payload, passed through untouched.",
      auth: "none",
      body: {
        description: "Sent with the subscriber's own headers; `event` becomes the X-LeadGenius-Event header.",
        properties: {
          event: { type: "string", description: "The event name." },
        },
      },
      responses: { "200": "The event is queued for delivery." },
    },
  },
  "/api/example-campaign": {
    post: {
      id: "exampleCampaign.load",
      summary: "Load the example campaign — one outreach that has already run, removable again. Session or key.",
      auth: "session-or-key",
      responses: { "201": "What was loaded.", "200": "It was already there." },
    },
    delete: {
      id: "exampleCampaign.remove",
      summary: "Take the example campaign away.",
      auth: "session-or-key",
      responses: { "200": "It is gone." },
    },
  },
  "/api/export": {
    get: {
      id: "export.workspace",
      summary: "The whole workspace as one JSON file.",
      auth: "session",
      responses: { "200": "The workspace." },
    },
  },
  "/api/export/activities": {
    get: {
      id: "export.activities",
      summary: "Every send's activity as a streamed CSV.",
      auth: "session",
      responses: { "200": "The CSV." },
    },
  },
  "/api/export/replies": {
    get: {
      id: "export.replies",
      summary: "The replies that came back as a streamed CSV.",
      auth: "session",
      responses: { "200": "The CSV." },
    },
  },
  "/api/export/sent-messages": {
    get: {
      id: "export.sentMessages",
      summary: "The messages that went out as a streamed CSV.",
      auth: "session",
      responses: { "200": "The CSV." },
    },
  },
  "/api/billing/checkout": {
    post: {
      id: "billing.checkout",
      summary: "Start a subscription.",
      auth: "session",
      body: {
        description: "The plan to buy.",
        properties: {
          plan: { type: "string", description: "monthly or annual." },
        },
      },
      responses: { "200": "The checkout URL." },
    },
  },
  "/api/billing/portal": {
    post: {
      id: "billing.portal",
      summary: "Open the billing portal — where a plan is changed or cancelled.",
      auth: "session",
      responses: { "200": "The portal URL." },
    },
  },
  "/api/billing/webhook": {
    post: {
      id: "billing.webhook",
      summary: "Stripe's own callback. Signed, not called with a key.",
      auth: "stripe",
      responses: { "200": "The event was recorded." },
    },
  },
};

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "LeadGenius API",
    version: VERSION,
    description:
      "Multichannel outreach with warmup and deliverability guardrails: contacts and lists, sequences across channels, sending accounts, merge values, A/B tests, and signed webhooks both ways.",
    contact: { name: "Abetworks", email: "support@abetworks.in" },
    license: { name: "Proprietary" },
  },
  servers: [{ url: "https://leadgenius.abetworks.in" }],
  paths: Object.fromEntries(
    Object.entries(PATHS).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item)
          .filter(([method]) => ["get", "post", "patch", "put", "delete"].includes(method))
          .map(([method, operation]) => [method, op(method as Method, operation as Operation)]),
      ),
    ]),
  ),
  components: {
    securitySchemes: {
      apiKey: {
        type: "http",
        scheme: "bearer",
        description: "A workspace API key, as 'Authorization: Bearer <key>' or 'x-api-key: <key>'.",
      },
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "abetworks_session",
        description: "The signed-in browser session — for the export and billing routes.",
      },
    },
  },
};

/** The operations, flattened: what the contract check reasons about. */
export const openapiOperations: { path: string; method: Method; operation: Operation }[] =
  Object.entries(PATHS).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({
      path,
      method: method as Method,
      operation: operation as Operation,
    })),
  );

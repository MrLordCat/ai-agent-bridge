/**
 * OpenAI function-call entry emitted by assistant messages.
 * Represents a tool call initiated by the assistant in a chat response.
 *
 */
export interface OpenAIToolCall {
	/**
	 * Unique identifier for the tool call.
	 */
	id: string;
	/**
	 * Type of the tool call, always "function".
	 */
	type: "function";
	/**
	 * Details of the function to call, including name and arguments.
	 */
	function: { name: string; arguments: string };
}

/**
 * OpenAI function tool definition used to advertise tools.
 * Defines a tool that can be called by the model, including its name, description, and parameters.
 *
 */
export interface OpenAIFunctionToolDef {
	/**
	 * Type of the tool, always "function".
	 */
	type: "function";
	/**
	 * Function details including name, description, and parameter schema.
	 */
	function: { name: string; description?: string; parameters?: object };
}

/**
 * Content block for multimodal (vision) messages following OpenAI format.
 */
export interface OpenAIContentPart {
	type: "text" | "image_url";
	text?: string;
	image_url?: {
		url: string;
		detail?: "auto" | "low" | "high";
	};
}

/**
 * OpenAI-style chat message used for router requests.
 * Represents a message in a chat conversation, compatible with OpenAI's API format.
 *
 */
export interface OpenAIChatMessage {
	/**
	 * Role of the message sender (system, user, assistant, or tool).
	 */
	role: OpenAIChatRole;
	/**
	 * Content of the message, optional for some roles.
	 * For multimodal (vision) messages this is an array of content parts.
	 */
	content?: string | OpenAIContentPart[];
	/**
	 * Name of the sender, optional.
	 */
	name?: string;
	/**
	 * Tool calls made by the assistant, if any.
	 */
	tool_calls?: OpenAIToolCall[];
	/**
	 * DeepSeek thinking-mode chain-of-thought payload.
	 * Required by DeepSeek on later turns when an assistant message made tool calls.
	 */
	reasoning_content?: string;
	/**
	 * ID of the tool call this message is responding to, if applicable.
	 */
	tool_call_id?: string;
}

/**
 * OpenAI-style chat roles.
 * Defines the possible roles for messages in a chat conversation.
 *
 */
export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";

#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  Request
} from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

// Get authentication information from environment variables
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN environment variables are required');
}

class GoogleFormsServer {
  private server: Server;
  private oauth2Client: OAuth2Client;
  private forms: any;

  constructor() {
    this.server = new Server(
      {
        name: 'google-forms-mcp',
        version: '0.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize OAuth2 client
    this.oauth2Client = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET
    );
    this.oauth2Client.setCredentials({
      refresh_token: REFRESH_TOKEN
    });

    // Initialize Google Forms API
    this.forms = google.forms({
      version: 'v1',
      auth: this.oauth2Client
    });

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error: Error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'create_form',
          description: 'Create a new Google Form',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Form title',
              },
              description: {
                type: 'string',
                description: 'Form description (optional)',
              }
            },
            required: ['title'],
          },
        },
        {
          name: 'add_text_question',
          description: 'Add a text question to the form (appended at the end)',
          inputSchema: {
            type: 'object',
            properties: {
              formId: {
                type: 'string',
                description: 'Form ID',
              },
              questionTitle: {
                type: 'string',
                description: 'Question title',
              },
              required: {
                type: 'boolean',
                description: 'Whether required (optional, default is false)',
              }
            },
            required: ['formId', 'questionTitle'],
          },
        },
        {
          name: 'add_multiple_choice_question',
          description: 'Add a multiple choice question to the form (appended at the end)',
          inputSchema: {
            type: 'object',
            properties: {
              formId: {
                type: 'string',
                description: 'Form ID',
              },
              questionTitle: {
                type: 'string',
                description: 'Question title',
              },
              options: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: 'Array of choices',
              },
              required: {
                type: 'boolean',
                description: 'Whether required (optional, default is false)',
              }
            },
            required: ['formId', 'questionTitle', 'options'],
          },
        },
        {
          name: 'get_form',
          description: 'Get form details',
          inputSchema: {
            type: 'object',
            properties: {
              formId: {
                type: 'string',
                description: 'Form ID',
              }
            },
            required: ['formId'],
          },
        },
        {
          name: 'get_form_responses',
          description: 'Get form responses',
          inputSchema: {
            type: 'object',
            properties: {
              formId: {
                type: 'string',
                description: 'Form ID',
              }
            },
            required: ['formId'],
          },
        },
        {
          name: 'reverse_form_items',
          description: 'Reverse the order of all items (questions) in a form. Useful for fixing forms whose items were inserted in reverse order.',
          inputSchema: {
            type: 'object',
            properties: {
              formId: {
                type: 'string',
                description: 'Form ID',
              }
            },
            required: ['formId'],
          },
        },
        {
          name: 'move_item',
          description: 'Move a single item to a new position in the form (0-indexed).',
          inputSchema: {
            type: 'object',
            properties: {
              formId: {
                type: 'string',
                description: 'Form ID',
              },
              fromIndex: {
                type: 'number',
                description: 'Current 0-indexed position of the item',
              },
              toIndex: {
                type: 'number',
                description: 'Target 0-indexed position of the item',
              }
            },
            required: ['formId', 'fromIndex', 'toIndex'],
          },
        }
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      try {
        switch (request.params.name) {
          case 'create_form':
            return await this.createForm(request.params.arguments);
          case 'add_text_question':
            return await this.addTextQuestion(request.params.arguments);
          case 'add_multiple_choice_question':
            return await this.addMultipleChoiceQuestion(request.params.arguments);
          case 'get_form':
            return await this.getForm(request.params.arguments);
          case 'get_form_responses':
            return await this.getFormResponses(request.params.arguments);
          case 'reverse_form_items':
            return await this.reverseFormItems(request.params.arguments);
          case 'move_item':
            return await this.moveItem(request.params.arguments);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error: any) {
        console.error('Error in tool execution:', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  // Helper: get the current item count of a form (so new items can be appended)
  private async getFormItemCount(formId: string): Promise<number> {
    const form = await this.forms.forms.get({ formId });
    const items = (form.data && form.data.items) || [];
    return items.length;
  }

  private async createForm(args: any) {
    if (!args.title) {
      throw new McpError(ErrorCode.InvalidParams, 'Title is required');
    }

    const form: any = {
      info: {
        title: args.title,
        documentTitle: args.title,
      }
    };

    if (args.description) {
      form.info.description = args.description;
    }

    try {
      const response = await this.forms.forms.create({
        requestBody: form,
      });

      const formId = response.data.formId;
      const responderUri = `https://docs.google.com/forms/d/${formId}/viewform`;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              formId,
              title: args.title,
              description: args.description || '',
              responderUri,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error('Error creating form:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create form: ${error.message}`
      );
    }
  }

  private async addTextQuestion(args: any) {
    if (!args.formId || !args.questionTitle) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Form ID and question title are required'
      );
    }

    try {
      // Fetch current item count so we can append at the end
      const itemCount = await this.getFormItemCount(args.formId);

      // Create a request to add a new question at the end
      const updateRequest = {
        requests: [
          {
            createItem: {
              item: {
                title: args.questionTitle,
                questionItem: {
                  question: {
                    required: args.required || false,
                    textQuestion: {}
                  }
                }
              },
              location: {
                index: itemCount
              }
            }
          }
        ]
      };

      // Update the form
      await this.forms.forms.batchUpdate({
        formId: args.formId,
        requestBody: updateRequest,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Text question added successfully',
              questionTitle: args.questionTitle,
              required: args.required || false,
              insertedAtIndex: itemCount,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error('Error adding text question:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to add text question: ${error.message}`
      );
    }
  }

  private async addMultipleChoiceQuestion(args: any) {
    if (!args.formId || !args.questionTitle || !args.options || !Array.isArray(args.options)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Form ID, question title, and options array are required'
      );
    }

    try {
      // Create choices
      const choices = args.options.map((option: string) => ({
        value: option
      }));

      // Fetch current item count so we can append at the end
      const itemCount = await this.getFormItemCount(args.formId);

      // Create a request to add a new question at the end
      const updateRequest = {
        requests: [
          {
            createItem: {
              item: {
                title: args.questionTitle,
                questionItem: {
                  question: {
                    required: args.required || false,
                    choiceQuestion: {
                      type: 'RADIO',
                      options: choices,
                    }
                  }
                }
              },
              location: {
                index: itemCount
              }
            }
          }
        ]
      };

      // Update the form
      await this.forms.forms.batchUpdate({
        formId: args.formId,
        requestBody: updateRequest,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Multiple choice question added successfully',
              questionTitle: args.questionTitle,
              options: args.options,
              required: args.required || false,
              insertedAtIndex: itemCount,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error('Error adding multiple choice question:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to add multiple choice question: ${error.message}`
      );
    }
  }

  private async getForm(args: any) {
    if (!args.formId) {
      throw new McpError(ErrorCode.InvalidParams, 'Form ID is required');
    }

    try {
      const response = await this.forms.forms.get({
        formId: args.formId,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error('Error getting form:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get form: ${error.message}`
      );
    }
  }

  private async getFormResponses(args: any) {
    if (!args.formId) {
      throw new McpError(ErrorCode.InvalidParams, 'Form ID is required');
    }

    try {
      const response = await this.forms.forms.responses.list({
        formId: args.formId,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error('Error getting form responses:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get form responses: ${error.message}`
      );
    }
  }

  // Reverse the order of every item in a form using a batch of moveItem requests.
  // Strategy: repeatedly pop the item at the bottom (index N-1) and insert it at the
  // current front. Google Forms API applies requests in order, so after N-1 moves the
  // list is fully reversed. Works in a single batchUpdate call.
  private async reverseFormItems(args: any) {
    if (!args.formId) {
      throw new McpError(ErrorCode.InvalidParams, 'Form ID is required');
    }

    try {
      const form = await this.forms.forms.get({ formId: args.formId });
      const items = (form.data && form.data.items) || [];
      const n = items.length;

      if (n < 2) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Form has fewer than 2 items; nothing to reverse.',
                itemCount: n,
              }, null, 2),
            },
          ],
        };
      }

      const requests: any[] = [];
      for (let i = 0; i < n - 1; i++) {
        requests.push({
          moveItem: {
            originalLocation: { index: n - 1 },
            newLocation: { index: i },
          }
        });
      }

      await this.forms.forms.batchUpdate({
        formId: args.formId,
        requestBody: { requests },
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Reversed ${n} items successfully.`,
              itemCount: n,
              moveRequests: requests.length,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error('Error reversing form items:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to reverse form items: ${error.message}`
      );
    }
  }

  // Move a single item to a new position.
  private async moveItem(args: any) {
    if (!args.formId || typeof args.fromIndex !== 'number' || typeof args.toIndex !== 'number') {
      throw new McpError(
        ErrorCode.InvalidParams,
        'formId, fromIndex (number), and toIndex (number) are required'
      );
    }

    try {
      await this.forms.forms.batchUpdate({
        formId: args.formId,
        requestBody: {
          requests: [
            {
              moveItem: {
                originalLocation: { index: args.fromIndex },
                newLocation: { index: args.toIndex },
              }
            }
          ]
        }
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Moved item from index ${args.fromIndex} to index ${args.toIndex}.`,
              fromIndex: args.fromIndex,
              toIndex: args.toIndex,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error('Error moving item:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to move item: ${error.message}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Google Forms MCP server running on stdio');
  }
}

const server = new GoogleFormsServer();
server.run().catch(console.error);

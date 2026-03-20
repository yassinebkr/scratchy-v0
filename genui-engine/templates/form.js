/**
 * Form Template - Tier 1 Instant Response
 * Generates form layout in <50ms
 */

export function generateForm(context = {}) {
  const {
    title = "Create New Entry",
    subtitle = "Fill out the form below",
    formId = "quick-form",
    fields = [],
    submitLabel = "Submit"
  } = context;

  return {
    ops: [
      {
        op: "clear"
      },
      {
        op: "upsert",
        id: "form-hero",
        type: "hero",
        data: {
          title,
          subtitle,
          icon: "📝",
          style: "accent"
        },
        layout: { zone: "auto" }
      },
      {
        op: "upsert",
        id: "main-form",
        type: "form",
        data: {
          title: "Form Details",
          id: formId,
          fields: fields.length > 0 ? fields : [
            { name: "name", type: "text", label: "Name", value: "" },
            { name: "email", type: "email", label: "Email", value: "" },
            { name: "message", type: "textarea", label: "Message", value: "" }
          ],
          actions: [
            { label: submitLabel, action: "submit", style: "primary" },
            { label: "Cancel", action: "cancel", style: "ghost" }
          ]
        },
        layout: { zone: "auto" }
      }
    ],
    timing: "<50ms",
    source: "tier1-form",
    confidence: 1.0
  };
}

export function parseFormContext(message) {
  const context = {};
  
  if (message.includes('email') || message.includes('compose')) {
    context.title = "Compose Email";
    context.formId = "email-compose";
    context.fields = [
      { name: "to", type: "email", label: "To", value: "" },
      { name: "subject", type: "text", label: "Subject", value: "" },
      { name: "body", type: "textarea", label: "Message", value: "" }
    ];
    context.submitLabel = "Send Email";
  }
  
  if (message.includes('account') || message.includes('user')) {
    context.title = "Create User Account";
    context.fields = [
      { name: "username", type: "text", label: "Username", value: "" },
      { name: "email", type: "email", label: "Email", value: "" },
      { name: "password", type: "password", label: "Password", value: "" },
      { name: "confirm", type: "password", label: "Confirm Password", value: "" }
    ];
  }
  
  if (message.includes('contact') || message.includes('feedback')) {
    context.title = "Contact Form";
    context.fields = [
      { name: "name", type: "text", label: "Your Name", value: "" },
      { name: "email", type: "email", label: "Email", value: "" },
      { name: "subject", type: "text", label: "Subject", value: "" },
      { name: "message", type: "textarea", label: "Your Message", value: "" }
    ];
    context.submitLabel = "Send Message";
  }
  
  return context;
}
import { z } from "zod";

const Message = z.object({
  id: z.string(),
  date: z.string(),
  type: z.string(),
  did: z.string(),
  contact: z.string(),
  message: z.string(),
});

const Response = z.object({
  status: z.string(),
  sms: z.array(Message),
});

export { Message, Response };

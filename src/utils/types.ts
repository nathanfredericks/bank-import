import { z } from "zod";

const Message = z.object({
  id: z.string(),
  to: z.string(),
  from: z.string().optional(),
  text: z.string(),
  created_at: z.coerce.date(),
});

const Response = z.array(Message);

export { Message, Response };

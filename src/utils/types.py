from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

class Message(BaseModel):
    id: str
    to: str
    from_: Optional[str]
    text: str
    created_at: datetime

class Response(BaseModel):
    __root__: List[Message]

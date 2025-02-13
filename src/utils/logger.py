import logging
from .env import env

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG if env.get("DEBUG") else logging.INFO)

handler = logging.StreamHandler()
handler.setFormatter(logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s"))

logger.addHandler(handler)

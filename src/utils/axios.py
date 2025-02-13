import requests

class AxiosInstance:
    def __init__(self):
        self.session = requests.Session()

    def post(self, url, data=None, json=None, **kwargs):
        return self.session.post(url, data=data, json=json, **kwargs)

    def get(self, url, **kwargs):
        return self.session.get(url, **kwargs)

    def put(self, url, data=None, **kwargs):
        return self.session.put(url, data=data, **kwargs)

    def delete(self, url, **kwargs):
        return self.session.delete(url, **kwargs)

instance = AxiosInstance()

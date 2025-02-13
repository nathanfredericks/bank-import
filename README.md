# bank-import

Import transactions from BMO, Tangerine, Manulife Bank and Rogers Bank to YNAB.

## Requirements

- Python 3.9 or higher
- Docker
- Docker Compose

## Setup

1. Clone the repository:

```sh
git clone https://github.com/nathanfredericks/bank-import.git
cd bank-import
```

2. Create a virtual environment and activate it:

```sh
python -m venv venv
source venv/bin/activate  # On Windows use `venv\Scripts\activate`
```

3. Install the dependencies:

```sh
pip install -r requirements.txt
```

4. Create a `.env` file with the necessary environment variables. Refer to `.env.example` for the required variables.

## Usage

1. Build and run the Docker containers:

```sh
docker-compose up --build
```

2. The transactions will be imported automatically based on the environment variables set in the `.env` file.

## Contributing

Feel free to open issues or submit pull requests if you have any improvements or bug fixes.

## License

This project is licensed under the MIT License.

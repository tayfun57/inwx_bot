import logging
import os  # required to use env vars

from dotenv import load_dotenv
from INWX.Domrobot import ApiClient

logging.basicConfig(level=logging.DEBUG, filename="log.txt", format='%(asctime)s %(levelname)s:%(message)s')
load_dotenv() # load .env file


api_client = ApiClient(api_url=ApiClient.API_LIVE_URL, debug_mode=False)


def login():
    """Login to INWX"""
    login_result = api_client.login(os.getenv('username') , os.getenv('password'))

    if login_result['code'] == 1000:
        return login_result
    else:
        err_message = 'Api login error. Code: ' + str(login_result['code']) + '  Message: ' + login_result['msg']
        logging.error(err_message)
        raise Exception(err_message)

def is_domain_free(domain_name):
    """Check if the Domain is free"""
    domain_check_result = api_client.call_api(api_method='domain.check', method_params={'domain': domain_name})

    if domain_check_result['code'] == 1000:
        checked_domain = domain_check_result['resData']['domain'][0]

        if checked_domain['avail']:
            return True
        else:
            err_message = domain_name + ' is not aviable'
            logging.debug(err_message)
    else:
        err_message = 'Api error while checking domain status. Code: ' + str(domain_check_result['code']) + '  Message: ' + domain_check_result['msg']
        logging.error(err_message)
        return False

def get_account_info():
    """Get required account info to buy the domain"""
    account_check_result = api_client.call_api(api_method='account.info')
    if account_check_result['code'] == 1000:
        return account_check_result
    else:
        err_message = 'Api error while getting account info. Code: ' + str(account_check_result['code']) + '  Message: ' + account_check_result['msg']
        logging.error(err_message)

def buy_domain(buy_params):
    """buy the domain"""
    domain_buy_result = api_client.call_api(api_method='domain.create', method_params=buy_params)

    if domain_buy_result['code'] == 1000:
        return True
    else:
        err_message = 'Api error while buying domain. Code: ' + str(domain_buy_result['code'])+ '  Message: ' + domain_buy_result['msg']
        logging.debug(err_message)
        return False

login()
account_info = get_account_info()
domains = open("domains.txt", encoding='utf-8').read().splitlines()
for domain in domains:
    if is_domain_free(domain):
        buy_domain({
        'domain': domain,
        'registrant': account_info['resData']['defaultRegistrant'],
        'admin': account_info['resData']['defaultAdmin'],
        'tech': account_info['resData']['defaultTech'],
        'billing': account_info['resData']['defaultBilling'],
        'ns': [os.getenv('ns1'), os.getenv('ns2')]
        })
api_client.logout()

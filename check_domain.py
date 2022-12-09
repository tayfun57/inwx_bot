import os
from dotenv import load_dotenv
from INWX.Domrobot import ApiClient

load_dotenv() # load .env file


api_client = ApiClient(api_url=ApiClient.API_LIVE_URL, debug_mode=False)

def login():
    login_result = api_client.login(os.getenv('username') , os.getenv('password'))

    if login_result['code'] == 1000:
        return login_result
    else:
        raise Exception('Api login error. Code: ' + str(login_result['code']) + '  Message: ' + login_result['msg'])

def isDomainFree(domainName):
    domain_check_result = api_client.call_api(api_method='domain.check', method_params={'domain': domainName})

    if domain_check_result['code'] == 1000:
        checked_domain = domain_check_result['resData']['domain'][0]

        if checked_domain['avail']:
            return True
        else:
            return False
    
    else:
        raise Exception('Api error while checking domain status. Code: ' + str(domain_check_result['code'])
                            + '  Message: ' + domain_check_result['msg'])

def getAccountInfo():
    account_check_result = api_client.call_api(api_method='account.info')
    if account_check_result['code'] == 1000:
        return account_check_result
    else:
        raise Exception('Api error while getting account info. Code: ' + str(account_check_result['code'])
                            + '  Message: ' + account_check_result['msg']) 

def buyDomain(buy_params):
    domain_buy_result = api_client.call_api(api_method='domain.create', method_params=buy_params)

    if domain_buy_result['code'] == 1000:
        return True
    else:
        raise Exception('Api error while buying domain. Code: ' + str(domain_buy_result['code'])
                            + '  Message: ' + domain_buy_result['msg'])


login()
account_info = getAccountInfo()
domains = open("domains.txt").read().splitlines()
for domain in domains:
    if isDomainFree(domain):
        buyDomain({
        'domain': domain,
        'registrant': account_info['resData']['defaultRegistrant'],
        'admin': account_info['resData']['defaultAdmin'],
        'tech': account_info['resData']['defaultTech'],
        'billing': account_info['resData']['defaultBilling'],
        'ns': [os.getenv('ns1'), os.getenv('ns2')]
        })
api_client.logout()
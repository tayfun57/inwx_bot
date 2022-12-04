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

def buyDomain(domainName):
    domain_buy_result = api_client.call_api(api_method='domain.create', method_params={
        'domain': domainName,
        'registrant': os.getenv('registrant'),
        'admin': os.getenv('admin'),
        'tech': os.getenv('tech'),
        'billing': os.getenv('billing')
        })

    if domain_buy_result['code'] == 1000:
        return True
    else:
        raise Exception('Api error while checking domain status. Code: ' + str(domain_buy_result['code'])
                            + '  Message: ' + domain_buy_result['msg'])



login()
domains = open("domains.txt").read().splitlines()
for domain in domains:
    if isDomainFree(domain):
        buyDomain(domain)
api_client.logout()
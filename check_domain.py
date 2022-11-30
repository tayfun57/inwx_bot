from INWX.Domrobot import ApiClient

username = 'DrByte'
password = 'ZFM_grh@hdz-zcz7kwj'

api_client = ApiClient(api_url=ApiClient.API_LIVE_URL, debug_mode=True)

def login():

    login_result = api_client.login(username, password)

    if login_result['code'] == 1000:
        return login_result
    else:
        raise Exception('Api login error. Code: ' + str(login_result['code']) + '  Message: ' + login_result['msg'])

def checkDomain(domainName):
    domain_check_result = api_client.call_api(api_method='domain.check', method_params={'domain': domainName})

    if domain_check_result['code'] == 1000:
        checked_domain = domain_check_result['resData']['domain'][0]

        if checked_domain['avail']:
            print(domain + ' is still available!')
        else:
            print('Unfortunately, ' + domain + ' is already registered.')
    
    else:
        raise Exception('Api error while checking domain status. Code: ' + str(domain_check_result['code'])
                            + '  Message: ' + domain_check_result['msg'])
    



login()
domains = open("domains.txt").read().splitlines()
for domain in domains:
    checkDomain(domain)
api_client.logout()